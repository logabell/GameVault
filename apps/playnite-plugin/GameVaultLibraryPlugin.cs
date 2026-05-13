using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading;
using Playnite.SDK;
using Playnite.SDK.Events;
using Playnite.SDK.Models;
using Playnite.SDK.Plugins;

namespace GameVault.Playnite
{
    [LoadPlugin]
    public class GameVaultLibraryPlugin : LibraryPlugin
    {
        private const string LibraryName = "GameVault";
        private const string PluginVersion = "0.1.14";
        private const int ManifestSyncDebounceMs = 1500;
        private const int MetadataBackfillDebounceMs = 8000;
        private const int MetadataBackfillGameDelayMs = 750;
        private static readonly ILogger logger = LogManager.GetLogger();
        private readonly object manifestSyncLock = new object();
        private readonly object metadataBackfillLock = new object();
        private readonly IPlayniteAPI playniteApi;
        private FileSystemWatcher manifestWatcher;
        private Timer manifestSyncTimer;
        private Timer metadataBackfillTimer;
        private SynchronizationContext playniteSynchronizationContext;
        private int metadataBackfillRunning;
        private string watchedManifestPath;

        public override Guid Id
        {
            get { return Guid.Parse("7bdf2a6f-5479-4e52-812d-9f56b4e79d7a"); }
        }

        public override string Name
        {
            get { return LibraryName; }
        }

        public GameVaultLibraryPlugin(IPlayniteAPI playniteApi) : base(playniteApi)
        {
            this.playniteApi = playniteApi;
            Properties = new LibraryPluginProperties
            {
                HasSettings = false
            };
        }

        public override IEnumerable<GameMetadata> GetGames(LibraryGetGamesArgs args)
        {
            string error;
            var manifest = ReadManifest(out error);
            if (manifest == null || manifest.Games == null)
            {
                WriteSyncStatus(manifest, 0, error);
                return Enumerable.Empty<GameMetadata>();
            }

            var importableGames = manifest.Games
                .Where(game => IsImportable(game))
                .ToList();

            ClearManifestImportExclusions(importableGames);
            ApplyExecutableIcons(importableGames);
            WriteSyncStatus(manifest, importableGames.Count, error);

            return importableGames
                .Select(ToGameMetadata)
                .ToList();
        }

        public override void OnApplicationStarted(OnApplicationStartedEventArgs args)
        {
            playniteSynchronizationContext = SynchronizationContext.Current;
            EnsureManifestWatcher();
            QueueManifestSync();
            QueueMetadataBackfill(MetadataBackfillDebounceMs);
        }

        public override void OnLibraryUpdated(OnLibraryUpdatedEventArgs args)
        {
            WriteCurrentSyncStatus();
            QueueMetadataBackfill();
        }

        public override void OnApplicationStopped(OnApplicationStoppedEventArgs args)
        {
            DisposeManifestWatcher();
            DisposeMetadataBackfill();
        }

        public override LibraryMetadataProvider GetMetadataDownloader()
        {
            return new GameVaultIgdbMetadataProvider(playniteApi, Id);
        }

        private static bool IsImportable(GameVaultManifestGame game)
        {
            return game != null &&
                game.SteamAppId > 0 &&
                !string.IsNullOrWhiteSpace(game.Title) &&
                !string.IsNullOrWhiteSpace(game.InstallPath) &&
                !string.IsNullOrWhiteSpace(game.ExecutablePath) &&
                File.Exists(game.ExecutablePath);
        }

        private static GameMetadata ToGameMetadata(GameVaultManifestGame game)
        {
            var tags = new HashSet<MetadataProperty>
            {
                new MetadataNameProperty(LibraryName)
            };
            var links = new List<Link>();
            if (!string.IsNullOrWhiteSpace(game.SteamStoreUrl))
            {
                links.Add(new Link("Steam Store", game.SteamStoreUrl));
            }

            return new GameMetadata
            {
                GameId = game.SteamAppId.ToString(),
                GameActions = new List<GameAction>
                {
                    new GameAction
                    {
                        Type = GameActionType.File,
                        Path = game.ExecutablePath,
                        WorkingDir = Path.GetDirectoryName(game.ExecutablePath),
                        IsPlayAction = true
                    }
                },
                Icon = GetExecutableIconMetadata(game),
                InstallDirectory = game.InstallPath,
                IsInstalled = true,
                Links = links,
                Name = string.IsNullOrWhiteSpace(game.SteamTitle) ? game.Title : game.SteamTitle,
                Source = new MetadataNameProperty(LibraryName),
                Tags = tags,
                Version = game.Version
            };
        }

        private void WriteCurrentSyncStatus()
        {
            string error;
            var manifest = ReadManifest(out error);
            var importableGames = manifest != null && manifest.Games != null
                ? manifest.Games.Where(game => IsImportable(game)).Count()
                : 0;
            if (manifest != null && manifest.Games != null)
            {
                ApplyExecutableIcons(manifest.Games.Where(game => IsImportable(game)).ToList());
            }
            WriteSyncStatus(manifest, importableGames, error);
        }

        private void ClearManifestImportExclusions(List<GameVaultManifestGame> importableGames)
        {
            try
            {
                var manifestIds = new HashSet<string>(
                    importableGames
                        .Where(game => game.SteamAppId > 0)
                        .Select(game => game.SteamAppId.ToString()));
                var exclusions = playniteApi.Database.ImportExclusions
                    .Where(exclusion =>
                        exclusion != null &&
                        exclusion.LibraryId == Id &&
                        manifestIds.Contains(exclusion.GameId))
                    .ToList();

                if (exclusions.Count > 0)
                {
                    playniteApi.Database.ImportExclusions.Remove(exclusions);
                }
            }
            catch
            {
                // Playnite import exclusions should not prevent manifest reporting.
            }
        }

        private void ApplyExecutableIcons(List<GameVaultManifestGame> importableGames)
        {
            try
            {
                var gamesById = importableGames
                    .GroupBy(game => game.SteamAppId)
                    .ToDictionary(group => group.Key, group => group.First());

                foreach (var game in playniteApi.Database.Games)
                {
                    int appId;
                    GameVaultManifestGame manifestGame;
                    if (game.PluginId == Id &&
                        !string.IsNullOrWhiteSpace(game.GameId) &&
                        int.TryParse(game.GameId, out appId) &&
                        gamesById.TryGetValue(appId, out manifestGame) &&
                        File.Exists(manifestGame.ExecutablePath))
                    {
                        var iconPath = GetExecutableIconPath(manifestGame);
                        if (!string.IsNullOrWhiteSpace(iconPath) &&
                            !string.Equals(game.Icon, iconPath, StringComparison.OrdinalIgnoreCase))
                        {
                            game.Icon = iconPath;
                            playniteApi.Database.Games.Update(game);
                        }
                    }
                }
            }
            catch
            {
                // Missing icons should never prevent library import or sync status reporting.
            }
        }

        private static MetadataFile GetExecutableIconMetadata(GameVaultManifestGame game)
        {
            var iconPath = GetExecutableIconPath(game);
            return string.IsNullOrWhiteSpace(iconPath) ? null : new MetadataFile(iconPath);
        }

        private static string GetExecutableIconPath(GameVaultManifestGame game)
        {
            try
            {
                if (game == null ||
                    game.SteamAppId <= 0 ||
                    string.IsNullOrWhiteSpace(game.ExecutablePath) ||
                    !File.Exists(game.ExecutablePath))
                {
                    return null;
                }

                var iconDirectory = GetIconDirectory();
                Directory.CreateDirectory(iconDirectory);
                var iconPath = Path.Combine(iconDirectory, GetExecutableIconFileName(game));
                var executableWriteTime = File.GetLastWriteTimeUtc(game.ExecutablePath);
                if (File.Exists(iconPath) &&
                    File.GetLastWriteTimeUtc(iconPath) >= executableWriteTime)
                {
                    return iconPath;
                }

                using (var icon = System.Drawing.Icon.ExtractAssociatedIcon(game.ExecutablePath))
                {
                    if (icon == null)
                    {
                        return null;
                    }

                    using (var bitmap = icon.ToBitmap())
                    {
                        bitmap.Save(iconPath, ImageFormat.Png);
                    }
                }

                return iconPath;
            }
            catch
            {
                return null;
            }
        }

        private static string GetExecutableIconFileName(GameVaultManifestGame game)
        {
            var executableName = Path.GetFileNameWithoutExtension(game.ExecutablePath);
            var safeName = new string(
                (executableName ?? "exe")
                    .Select(character => char.IsLetterOrDigit(character) ? character : '-')
                    .ToArray())
                .Trim('-');
            if (string.IsNullOrWhiteSpace(safeName))
            {
                safeName = "exe";
            }

            if (safeName.Length > 40)
            {
                safeName = safeName.Substring(0, 40);
            }

            return game.SteamAppId + "-" + safeName + "-" + StablePathHash(game.ExecutablePath) + ".png";
        }

        private static string StablePathHash(string value)
        {
            unchecked
            {
                var hash = 2166136261u;
                foreach (var character in (value ?? string.Empty).ToLowerInvariant())
                {
                    hash ^= character;
                    hash *= 16777619u;
                }

                return hash.ToString("x8");
            }
        }

        private void EnsureManifestWatcher()
        {
            try
            {
                var manifestPath = GetManifestPath();
                var manifestDirectory = Path.GetDirectoryName(manifestPath);
                if (string.IsNullOrWhiteSpace(manifestDirectory))
                {
                    return;
                }

                if (manifestWatcher != null &&
                    string.Equals(watchedManifestPath, manifestPath, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }

                DisposeManifestWatcher();
                Directory.CreateDirectory(manifestDirectory);

                manifestWatcher = new FileSystemWatcher(manifestDirectory, Path.GetFileName(manifestPath))
                {
                    NotifyFilter = NotifyFilters.CreationTime |
                        NotifyFilters.FileName |
                        NotifyFilters.LastWrite |
                        NotifyFilters.Size
                };
                manifestWatcher.Changed += OnManifestFileChanged;
                manifestWatcher.Created += OnManifestFileChanged;
                manifestWatcher.Renamed += OnManifestFileRenamed;
                manifestWatcher.EnableRaisingEvents = true;
                watchedManifestPath = manifestPath;
            }
            catch
            {
                // Manifest watching is a convenience; manual Playnite library updates still work.
            }
        }

        private void DisposeManifestWatcher()
        {
            try
            {
                if (manifestWatcher != null)
                {
                    manifestWatcher.Dispose();
                    manifestWatcher = null;
                }

                if (manifestSyncTimer != null)
                {
                    manifestSyncTimer.Dispose();
                    manifestSyncTimer = null;
                }

                watchedManifestPath = null;
            }
            catch
            {
                // Shutdown cleanup should never block Playnite.
            }
        }

        private void OnManifestFileChanged(object sender, FileSystemEventArgs args)
        {
            QueueManifestSync();
        }

        private void OnManifestFileRenamed(object sender, RenamedEventArgs args)
        {
            QueueManifestSync();
        }

        private void QueueManifestSync()
        {
            try
            {
                EnsureManifestWatcher();
                if (manifestSyncTimer == null)
                {
                    manifestSyncTimer = new Timer(_ => RunManifestSyncOnUiThread(), null, Timeout.Infinite, Timeout.Infinite);
                }

                manifestSyncTimer.Change(ManifestSyncDebounceMs, Timeout.Infinite);
            }
            catch
            {
                // Sync status will be refreshed the next time Playnite asks for library games.
            }
        }

        private void RunManifestSyncOnUiThread()
        {
            try
            {
                if (playniteSynchronizationContext != null)
                {
                    playniteSynchronizationContext.Post(_ => SyncManifestIntoPlaynite(), null);
                    return;
                }

                SyncManifestIntoPlaynite();
            }
            catch
            {
                // File watcher callbacks should never bubble into Playnite.
            }
        }

        private void SyncManifestIntoPlaynite()
        {
            lock (manifestSyncLock)
            {
                string error;
                var manifest = ReadManifest(out error);
                if (manifest == null || manifest.Games == null)
                {
                    WriteSyncStatus(manifest, 0, error);
                    return;
                }

                var importableGames = manifest.Games
                    .Where(game => IsImportable(game))
                    .ToList();

                ClearManifestImportExclusions(importableGames);
                RemoveMissingManifestGames(importableGames);
                ImportOrUpdateManifestGames(importableGames);
                ApplyExecutableIcons(importableGames);
                WriteSyncStatus(manifest, importableGames.Count, error);
                QueueMetadataBackfill();
            }
        }

        private void RemoveMissingManifestGames(List<GameVaultManifestGame> importableGames)
        {
            try
            {
                var manifestIds = new HashSet<string>(
                    importableGames
                        .Where(game => game.SteamAppId > 0)
                        .Select(game => game.SteamAppId.ToString()));
                var missingGames = playniteApi.Database.Games
                    .Where(game =>
                        game.PluginId == Id &&
                        !string.IsNullOrWhiteSpace(game.GameId) &&
                        !manifestIds.Contains(game.GameId))
                    .ToList();

                if (missingGames.Count > 0)
                {
                    playniteApi.Database.Games.Remove(missingGames);
                }
            }
            catch
            {
                // Removing stale library entries should not prevent fresh entries from syncing.
            }
        }

        private void ImportOrUpdateManifestGames(List<GameVaultManifestGame> importableGames)
        {
            try
            {
                var existingGamesById = playniteApi.Database.Games
                    .Where(game => game.PluginId == Id && !string.IsNullOrWhiteSpace(game.GameId))
                    .GroupBy(game => game.GameId)
                    .ToDictionary(group => group.Key, group => group.First());

                foreach (var manifestGame in importableGames)
                {
                    var gameId = manifestGame.SteamAppId.ToString();
                    Game existingGame;
                    if (!existingGamesById.TryGetValue(gameId, out existingGame))
                    {
                        var imported = playniteApi.Database.ImportGame(ToGameMetadata(manifestGame), this);
                        if (imported != null && !string.IsNullOrWhiteSpace(imported.GameId))
                        {
                            existingGamesById[imported.GameId] = imported;
                        }
                        continue;
                    }

                    if (ApplyManifestMetadata(existingGame, manifestGame))
                    {
                        playniteApi.Database.Games.Update(existingGame);
                    }
                }
            }
            catch
            {
                // Playnite can still import through the regular library update path.
            }
        }

        private static bool ApplyManifestMetadata(Game game, GameVaultManifestGame manifestGame)
        {
            var changed = false;
            if (!string.Equals(game.InstallDirectory, manifestGame.InstallPath, StringComparison.OrdinalIgnoreCase))
            {
                game.InstallDirectory = manifestGame.InstallPath;
                changed = true;
            }

            if (!game.IsInstalled)
            {
                game.IsInstalled = true;
                changed = true;
            }

            if (!string.Equals(game.Version, manifestGame.Version, StringComparison.Ordinal))
            {
                game.Version = manifestGame.Version;
                changed = true;
            }

            var iconPath = GetExecutableIconPath(manifestGame);
            if (!string.IsNullOrWhiteSpace(iconPath) &&
                !string.Equals(game.Icon, iconPath, StringComparison.OrdinalIgnoreCase))
            {
                game.Icon = iconPath;
                changed = true;
            }

            return ApplyManifestPlayAction(game, manifestGame) || changed;
        }

        private static bool ApplyManifestPlayAction(Game game, GameVaultManifestGame manifestGame)
        {
            var changed = false;
            if (game.GameActions == null)
            {
                game.GameActions = new ObservableCollection<GameAction>();
                changed = true;
            }

            var playAction = game.GameActions.FirstOrDefault(action => action != null && action.IsPlayAction);
            if (playAction == null)
            {
                game.GameActions.Add(CreatePlayAction(manifestGame));
                return true;
            }

            if (playAction.Type != GameActionType.File)
            {
                playAction.Type = GameActionType.File;
                changed = true;
            }

            if (!string.Equals(playAction.Path, manifestGame.ExecutablePath, StringComparison.OrdinalIgnoreCase))
            {
                playAction.Path = manifestGame.ExecutablePath;
                changed = true;
            }

            var workingDirectory = Path.GetDirectoryName(manifestGame.ExecutablePath);
            if (!string.Equals(playAction.WorkingDir, workingDirectory, StringComparison.OrdinalIgnoreCase))
            {
                playAction.WorkingDir = workingDirectory;
                changed = true;
            }

            if (!playAction.IsPlayAction)
            {
                playAction.IsPlayAction = true;
                changed = true;
            }

            return changed;
        }

        private static GameAction CreatePlayAction(GameVaultManifestGame game)
        {
            return new GameAction
            {
                Type = GameActionType.File,
                Path = game.ExecutablePath,
                WorkingDir = Path.GetDirectoryName(game.ExecutablePath),
                IsPlayAction = true
            };
        }

        private void QueueMetadataBackfill()
        {
            QueueMetadataBackfill(MetadataBackfillDebounceMs);
        }

        private void QueueMetadataBackfill(int delayMs)
        {
            try
            {
                lock (metadataBackfillLock)
                {
                    if (metadataBackfillTimer == null)
                    {
                        metadataBackfillTimer = new Timer(_ => RunMetadataBackfill(), null, Timeout.Infinite, Timeout.Infinite);
                    }

                    metadataBackfillTimer.Change(Math.Max(1000, delayMs), Timeout.Infinite);
                }
            }
            catch
            {
                // Metadata can still be downloaded manually from Playnite.
            }
        }

        private void DisposeMetadataBackfill()
        {
            try
            {
                lock (metadataBackfillLock)
                {
                    if (metadataBackfillTimer != null)
                    {
                        metadataBackfillTimer.Dispose();
                        metadataBackfillTimer = null;
                    }
                }
            }
            catch
            {
                // Shutdown cleanup should never block Playnite.
            }
        }

        private void RunMetadataBackfill()
        {
            if (Interlocked.Exchange(ref metadataBackfillRunning, 1) == 1)
            {
                QueueMetadataBackfill();
                return;
            }

            try
            {
                var igdbAvailable = RunOnPlayniteThread(() => GetIgdbMetadataPlugin(playniteApi) != null);
                if (!igdbAvailable)
                {
                    logger.Warn("GameVault IGDB metadata backfill skipped because the IGDB metadata provider is not available.");
                    return;
                }

                var games = RunOnPlayniteThread(GetMetadataBackfillCandidates);
                if (games.Count == 0)
                {
                    return;
                }

                logger.Info("GameVault IGDB metadata backfill starting for " + games.Count + " game(s).");
                var updatedGames = 0;

                foreach (var game in games)
                {
                    GameMetadata metadata = null;
                    try
                    {
                        metadata = DownloadIgdbMetadata(playniteApi, game);
                    }
                    catch (Exception downloadError)
                    {
                        logger.Warn(downloadError, "GameVault IGDB metadata download failed for " + game.Name + ".");
                    }

                    if (metadata != null)
                    {
                        var gameId = game.Id;
                        var changed = RunOnPlayniteThread(() => ApplyIgdbMetadata(gameId, metadata));
                        if (changed)
                        {
                            updatedGames++;
                        }
                    }

                    Thread.Sleep(MetadataBackfillGameDelayMs);
                }

                logger.Info("GameVault IGDB metadata backfill finished. Updated " + updatedGames + " of " + games.Count + " game(s).");
            }
            catch (Exception error)
            {
                logger.Warn(error, "GameVault IGDB metadata backfill failed.");
            }
            finally
            {
                Interlocked.Exchange(ref metadataBackfillRunning, 0);
            }
        }

        private T RunOnPlayniteThread<T>(Func<T> action)
        {
            var context = playniteSynchronizationContext;
            if (context == null || SynchronizationContext.Current == context)
            {
                return action();
            }

            T result = default(T);
            Exception error = null;
            using (var waitHandle = new ManualResetEvent(false))
            {
                context.Post(_ =>
                {
                    try
                    {
                        result = action();
                    }
                    catch (Exception actionError)
                    {
                        error = actionError;
                    }
                    finally
                    {
                        waitHandle.Set();
                    }
                }, null);

                if (!waitHandle.WaitOne(TimeSpan.FromSeconds(30)))
                {
                    throw new TimeoutException("Timed out waiting for Playnite UI thread.");
                }
            }

            if (error != null)
            {
                throw error;
            }

            return result;
        }

        private List<Game> GetMetadataBackfillCandidates()
        {
            try
            {
                return playniteApi.Database.Games
                    .Where(ShouldBackfillIgdbMetadata)
                    .Select(CreateMetadataRequestGame)
                    .ToList();
            }
            catch
            {
                return new List<Game>();
            }
        }

        private static Game CreateMetadataRequestGame(Game game)
        {
            return new Game(game.Name)
            {
                Id = game.Id,
                GameId = game.GameId,
                PluginId = game.PluginId,
                SourceId = game.SourceId,
                Description = game.Description,
                CoverImage = game.CoverImage,
                ReleaseDate = game.ReleaseDate,
                GenreIds = CopyIds(game.GenreIds),
                DeveloperIds = CopyIds(game.DeveloperIds),
                PublisherIds = CopyIds(game.PublisherIds)
            };
        }

        private static List<Guid> CopyIds(IEnumerable<Guid> ids)
        {
            return ids == null ? null : ids.ToList();
        }

        private bool ShouldBackfillIgdbMetadata(Game game)
        {
            return IsGameVaultGame(game) &&
                !string.IsNullOrWhiteSpace(game.GameId) &&
                (string.IsNullOrWhiteSpace(game.Description) ||
                    game.ReleaseDate == null ||
                    string.IsNullOrWhiteSpace(game.CoverImage) ||
                    !HasItems(game.GenreIds) ||
                    !HasItems(game.DeveloperIds) ||
                    !HasItems(game.PublisherIds));
        }

        private bool IsGameVaultGame(Game game)
        {
            return game != null &&
                (game.PluginId == Id ||
                    IsNamedMetadata(game.Source, LibraryName) ||
                    HasNamedMetadata(game.Tags, LibraryName));
        }

        private static bool IsNamedMetadata(DatabaseObject metadata, string name)
        {
            return metadata != null &&
                string.Equals(metadata.Name, name, StringComparison.OrdinalIgnoreCase);
        }

        private static bool HasNamedMetadata<T>(IEnumerable<T> metadata, string name) where T : DatabaseObject
        {
            return metadata != null &&
                metadata.Any(item => IsNamedMetadata(item, name));
        }

        private bool ApplyIgdbMetadata(Guid gameId, GameMetadata metadata)
        {
            try
            {
                var game = playniteApi.Database.Games.Get(gameId);
                if (!ShouldBackfillIgdbMetadata(game) || metadata == null)
                {
                    return false;
                }

                var changed = false;
                if (string.IsNullOrWhiteSpace(game.Description) &&
                    !string.IsNullOrWhiteSpace(metadata.Description))
                {
                    game.Description = metadata.Description;
                    changed = true;
                }

                if (game.ReleaseDate == null && metadata.ReleaseDate != null)
                {
                    game.ReleaseDate = metadata.ReleaseDate;
                    changed = true;
                }

                if (game.CriticScore == null && metadata.CriticScore != null)
                {
                    game.CriticScore = metadata.CriticScore;
                    changed = true;
                }

                if (game.CommunityScore == null && metadata.CommunityScore != null)
                {
                    game.CommunityScore = metadata.CommunityScore;
                    changed = true;
                }

                changed |= TryApplyMetadataImage(metadata.CoverImage, game.Id, game.CoverImage, value => game.CoverImage = value);
                changed |= TryApplyMetadataImage(metadata.BackgroundImage, game.Id, game.BackgroundImage, value => game.BackgroundImage = value);
                changed |= MergeLinks(game, metadata.Links);
                changed |= SetMetadataIdsIfEmpty(game.GenreIds, metadata.Genres, properties => playniteApi.Database.Genres.Add(properties), ids => game.GenreIds = ids);
                changed |= SetMetadataIdsIfEmpty(game.DeveloperIds, metadata.Developers, properties => playniteApi.Database.Companies.Add(properties), ids => game.DeveloperIds = ids);
                changed |= SetMetadataIdsIfEmpty(game.PublisherIds, metadata.Publishers, properties => playniteApi.Database.Companies.Add(properties), ids => game.PublisherIds = ids);
                changed |= SetMetadataIdsIfEmpty(game.FeatureIds, metadata.Features, properties => playniteApi.Database.Features.Add(properties), ids => game.FeatureIds = ids);
                changed |= SetMetadataIdsIfEmpty(game.SeriesIds, metadata.Series, properties => playniteApi.Database.Series.Add(properties), ids => game.SeriesIds = ids);
                changed |= SetMetadataIdsIfEmpty(game.AgeRatingIds, metadata.AgeRatings, properties => playniteApi.Database.AgeRatings.Add(properties), ids => game.AgeRatingIds = ids);
                changed |= SetMetadataIdsIfEmpty(game.RegionIds, metadata.Regions, properties => playniteApi.Database.Regions.Add(properties), ids => game.RegionIds = ids);
                changed |= SetMetadataIdsIfEmpty(game.PlatformIds, metadata.Platforms, properties => playniteApi.Database.Platforms.Add(properties), ids => game.PlatformIds = ids);
                changed |= MergeTagsIfOnlyGameVault(game, metadata.Tags);

                if (changed)
                {
                    playniteApi.Database.Games.Update(game);
                }

                return changed;
            }
            catch (Exception error)
            {
                logger.Warn(error, "Could not apply IGDB metadata for GameVault game.");
                return false;
            }
        }

        private bool TryApplyMetadataImage(MetadataFile metadataFile, Guid gameId, string currentValue, Action<string> setter)
        {
            if (!string.IsNullOrWhiteSpace(currentValue) || metadataFile == null)
            {
                return false;
            }

            var file = SaveMetadataFile(metadataFile, gameId);
            if (string.IsNullOrWhiteSpace(file))
            {
                return false;
            }

            setter(file);
            return true;
        }

        private string SaveMetadataFile(MetadataFile metadataFile, Guid gameId)
        {
            try
            {
                if (metadataFile.Content != null && metadataFile.Content.Length > 0)
                {
                    var tempPath = Path.Combine(
                        Path.GetTempPath(),
                        "gamevault-" + Guid.NewGuid().ToString("N") + GetMetadataFileExtension(metadataFile));
                    File.WriteAllBytes(tempPath, metadataFile.Content);
                    try
                    {
                        return playniteApi.Database.AddFile(tempPath, gameId);
                    }
                    finally
                    {
                        TryDeleteFile(tempPath);
                    }
                }

                if (!string.IsNullOrWhiteSpace(metadataFile.Path))
                {
                    if (File.Exists(metadataFile.Path))
                    {
                        return playniteApi.Database.AddFile(metadataFile.Path, gameId);
                    }

                    return metadataFile.Path;
                }
            }
            catch (Exception error)
            {
                logger.Warn(error, "Could not save IGDB metadata image for GameVault game.");
            }

            return null;
        }

        private static string GetMetadataFileExtension(MetadataFile metadataFile)
        {
            var fileName = metadataFile.FileName;
            if (string.IsNullOrWhiteSpace(fileName))
            {
                fileName = metadataFile.Path;
            }

            var extension = string.IsNullOrWhiteSpace(fileName) ? null : Path.GetExtension(fileName);
            return string.IsNullOrWhiteSpace(extension) || extension.Length > 10 ? ".tmp" : extension;
        }

        private static void TryDeleteFile(string path)
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // Temporary image files can be cleaned by the OS later.
            }
        }

        private static bool MergeLinks(Game game, IEnumerable<Link> links)
        {
            if (!HasItems(links))
            {
                return false;
            }

            if (game.Links == null)
            {
                game.Links = new ObservableCollection<Link>();
            }

            var existingLinks = new HashSet<string>(
                game.Links
                    .Where(link => link != null)
                    .Select(link => GetLinkKey(link)));
            var changed = false;

            foreach (var link in links.Where(link => link != null))
            {
                var key = GetLinkKey(link);
                if (existingLinks.Contains(key))
                {
                    continue;
                }

                game.Links.Add(new Link(link.Name, link.Url));
                existingLinks.Add(key);
                changed = true;
            }

            return changed;
        }

        private static string GetLinkKey(Link link)
        {
            return ((link.Name ?? string.Empty) + "\n" + (link.Url ?? string.Empty)).ToLowerInvariant();
        }

        private static bool SetMetadataIdsIfEmpty<TItem>(
            List<Guid> currentIds,
            IEnumerable<MetadataProperty> properties,
            Func<IEnumerable<MetadataProperty>, IEnumerable<TItem>> addItems,
            Action<List<Guid>> setIds) where TItem : DatabaseObject
        {
            if (HasItems(currentIds) || !HasItems(properties))
            {
                return false;
            }

            var ids = addItems(properties)
                .Where(item => item != null && item.Id != Guid.Empty)
                .Select(item => item.Id)
                .Distinct()
                .ToList();
            if (ids.Count == 0)
            {
                return false;
            }

            setIds(ids);
            return true;
        }

        private bool MergeTagsIfOnlyGameVault(Game game, IEnumerable<MetadataProperty> properties)
        {
            if (!HasItems(properties))
            {
                return false;
            }

            var currentTags = game.Tags ?? new List<Tag>();
            var canMergeTags = currentTags.Count == 0 ||
                currentTags.All(tag => IsNamedMetadata(tag, LibraryName));
            if (!canMergeTags)
            {
                return false;
            }

            var currentIds = game.TagIds ?? new List<Guid>();
            var currentIdSet = new HashSet<Guid>(currentIds);
            var addedTags = playniteApi.Database.Tags.Add(properties)
                .Where(tag => tag != null && tag.Id != Guid.Empty)
                .ToList();
            foreach (var tag in addedTags)
            {
                currentIdSet.Add(tag.Id);
            }

            if (currentIdSet.Count == currentIds.Distinct().Count())
            {
                return false;
            }

            game.TagIds = currentIdSet.ToList();
            return true;
        }

        private static MetadataPlugin GetIgdbMetadataPlugin(IPlayniteAPI api)
        {
            if (api == null || api.Addons == null || api.Addons.Plugins == null)
            {
                return null;
            }

            var igdbPluginId = BuiltinExtensions.GetIdFromExtension(BuiltinExtension.IgdbMetadata);
            if (api.Addons.DisabledAddons != null &&
                api.Addons.DisabledAddons.Any(disabled =>
                    string.Equals(disabled, igdbPluginId.ToString(), StringComparison.OrdinalIgnoreCase)))
            {
                return null;
            }

            return api.Addons.Plugins
                .OfType<MetadataPlugin>()
                .FirstOrDefault(plugin => plugin.Id == igdbPluginId) ??
                api.Addons.Plugins
                    .OfType<MetadataPlugin>()
                    .FirstOrDefault(plugin =>
                        string.Equals(plugin.Name, "IGDB", StringComparison.OrdinalIgnoreCase));
        }

        private static GameMetadata DownloadIgdbMetadata(IPlayniteAPI api, Game game)
        {
            var metadataPlugin = GetIgdbMetadataPlugin(api);
            if (metadataPlugin == null || game == null)
            {
                return null;
            }

            using (var provider = metadataPlugin.GetMetadataProvider(
                new MetadataRequestOptions(game, true)))
            {
                if (provider == null)
                {
                    return null;
                }

                return BuildMetadata(provider);
            }
        }

        private static GameMetadata BuildMetadata(OnDemandMetadataProvider provider)
        {
            var metadata = new GameMetadata();
            var args = new GetMetadataFieldArgs();
            var availableFields = GetAvailableFields(provider);

            if (availableFields.Contains(MetadataField.Name))
            {
                TrySetMetadata(() => metadata.Name = provider.GetName(args));
            }

            if (availableFields.Contains(MetadataField.Genres))
            {
                TrySetMetadata(() => metadata.Genres = ToMetadataSet(provider.GetGenres(args)));
            }

            if (availableFields.Contains(MetadataField.ReleaseDate))
            {
                TrySetMetadata(() => metadata.ReleaseDate = provider.GetReleaseDate(args));
            }

            if (availableFields.Contains(MetadataField.Developers))
            {
                TrySetMetadata(() => metadata.Developers = ToMetadataSet(provider.GetDevelopers(args)));
            }

            if (availableFields.Contains(MetadataField.Publishers))
            {
                TrySetMetadata(() => metadata.Publishers = ToMetadataSet(provider.GetPublishers(args)));
            }

            if (availableFields.Contains(MetadataField.Tags))
            {
                TrySetMetadata(() => metadata.Tags = ToMetadataSet(provider.GetTags(args)));
            }

            if (availableFields.Contains(MetadataField.Description))
            {
                TrySetMetadata(() => metadata.Description = provider.GetDescription(args));
            }

            if (availableFields.Contains(MetadataField.Links))
            {
                TrySetMetadata(() =>
                {
                    var links = provider.GetLinks(args);
                    metadata.Links = links == null ? null : links.Where(link => link != null).ToList();
                });
            }

            if (availableFields.Contains(MetadataField.CriticScore))
            {
                TrySetMetadata(() => metadata.CriticScore = provider.GetCriticScore(args));
            }

            if (availableFields.Contains(MetadataField.CommunityScore))
            {
                TrySetMetadata(() => metadata.CommunityScore = provider.GetCommunityScore(args));
            }

            if (availableFields.Contains(MetadataField.CoverImage))
            {
                TrySetMetadata(() => metadata.CoverImage = MaterializeMetadataFile(provider.GetCoverImage(args)));
            }

            if (availableFields.Contains(MetadataField.BackgroundImage))
            {
                TrySetMetadata(() => metadata.BackgroundImage = MaterializeMetadataFile(provider.GetBackgroundImage(args)));
            }

            if (availableFields.Contains(MetadataField.Features))
            {
                TrySetMetadata(() => metadata.Features = ToMetadataSet(provider.GetFeatures(args)));
            }

            if (availableFields.Contains(MetadataField.AgeRating))
            {
                TrySetMetadata(() => metadata.AgeRatings = ToMetadataSet(provider.GetAgeRatings(args)));
            }

            if (availableFields.Contains(MetadataField.Series))
            {
                TrySetMetadata(() => metadata.Series = ToMetadataSet(provider.GetSeries(args)));
            }

            if (availableFields.Contains(MetadataField.Region))
            {
                TrySetMetadata(() => metadata.Regions = ToMetadataSet(provider.GetRegions(args)));
            }

            if (availableFields.Contains(MetadataField.Platform))
            {
                TrySetMetadata(() => metadata.Platforms = ToMetadataSet(provider.GetPlatforms(args)));
            }

            return MetadataIsEmpty(metadata) ? null : metadata;
        }

        private static List<MetadataField> GetAvailableFields(OnDemandMetadataProvider provider)
        {
            try
            {
                return provider.AvailableFields ?? new List<MetadataField>();
            }
            catch
            {
                return new List<MetadataField>();
            }
        }

        private static MetadataFile MaterializeMetadataFile(MetadataFile metadataFile)
        {
            if (metadataFile == null ||
                metadataFile.Content != null ||
                string.IsNullOrWhiteSpace(metadataFile.Path) ||
                !File.Exists(metadataFile.Path))
            {
                return metadataFile;
            }

            try
            {
                var fileName = metadataFile.FileName;
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    fileName = Path.GetFileName(metadataFile.Path);
                }

                return new MetadataFile(fileName, File.ReadAllBytes(metadataFile.Path));
            }
            catch
            {
                return metadataFile;
            }
        }

        private static void TrySetMetadata(Action setter)
        {
            try
            {
                setter();
            }
            catch
            {
                // Individual IGDB fields can fail independently.
            }
        }

        private static HashSet<MetadataProperty> ToMetadataSet(
            IEnumerable<MetadataProperty> properties)
        {
            return properties == null
                ? null
                : new HashSet<MetadataProperty>(properties.Where(property => property != null));
        }

        private static bool MetadataIsEmpty(GameMetadata metadata)
        {
            return metadata == null ||
                (string.IsNullOrWhiteSpace(metadata.Name) &&
                    string.IsNullOrWhiteSpace(metadata.Description) &&
                    metadata.ReleaseDate == null &&
                    metadata.CriticScore == null &&
                    metadata.CommunityScore == null &&
                    metadata.CoverImage == null &&
                    metadata.BackgroundImage == null &&
                    !HasItems(metadata.Links) &&
                    !HasItems(metadata.Genres) &&
                    !HasItems(metadata.Developers) &&
                    !HasItems(metadata.Publishers) &&
                    !HasItems(metadata.Tags) &&
                    !HasItems(metadata.Features) &&
                    !HasItems(metadata.AgeRatings) &&
                    !HasItems(metadata.Series) &&
                    !HasItems(metadata.Regions) &&
                    !HasItems(metadata.Platforms));
        }

        private static bool HasItems<T>(IEnumerable<T> items)
        {
            return items != null && items.Any();
        }

        private class GameVaultIgdbMetadataProvider : LibraryMetadataProvider
        {
            private readonly IPlayniteAPI api;
            private readonly Guid pluginId;

            public GameVaultIgdbMetadataProvider(IPlayniteAPI api, Guid pluginId)
            {
                this.api = api;
                this.pluginId = pluginId;
            }

            public override GameMetadata GetMetadata(Game game)
            {
                try
                {
                    if (game == null ||
                        game.PluginId != pluginId ||
                        string.IsNullOrWhiteSpace(game.GameId))
                    {
                        return null;
                    }

                    return DownloadIgdbMetadata(api, game);
                }
                catch
                {
                    return null;
                }
            }
        }

        private void WriteSyncStatus(GameVaultManifest manifest, int importableGames, string error)
        {
            try
            {
                var manifestGames = manifest != null && manifest.Games != null
                    ? manifest.Games
                    : new List<GameVaultManifestGame>();
                var manifestIds = new HashSet<int>(
                    manifestGames
                        .Where(game => game != null && game.SteamAppId > 0)
                        .Select(game => game.SteamAppId));
                var syncedIds = new HashSet<int>();

                try
                {
                    foreach (var game in playniteApi.Database.Games)
                    {
                        int appId;
                        if (game.PluginId == Id &&
                            !string.IsNullOrWhiteSpace(game.GameId) &&
                            int.TryParse(game.GameId, out appId) &&
                            manifestIds.Contains(appId))
                        {
                            syncedIds.Add(appId);
                        }
                    }
                }
                catch (Exception databaseError)
                {
                    if (string.IsNullOrWhiteSpace(error))
                    {
                        error = databaseError.Message;
                    }
                }

                var status = new GameVaultSyncStatus
                {
                    ExportableGames = manifestGames.Count,
                    ImportableGames = importableGames,
                    LastError = error,
                    ManifestGeneratedAt = manifest != null ? manifest.GeneratedAt : null,
                    ManifestPath = GetManifestPath(),
                    PluginVersion = PluginVersion,
                    SeenAt = DateTime.UtcNow.ToString("o"),
                    SyncedGames = syncedIds.Count
                };

                var statusPath = GetStatusPath();
                Directory.CreateDirectory(Path.GetDirectoryName(statusPath));
                using (var stream = File.Create(statusPath))
                {
                    var serializer = new DataContractJsonSerializer(typeof(GameVaultSyncStatus));
                    serializer.WriteObject(stream, status);
                }
            }
            catch
            {
                // Sync status should never prevent Playnite from loading the library.
            }
        }

        private static GameVaultManifest ReadManifest(out string error)
        {
            error = null;
            var manifestPath = GetManifestPath();
            if (!File.Exists(manifestPath))
            {
                error = "GameVault manifest was not found.";
                return null;
            }

            try
            {
                using (var stream = File.OpenRead(manifestPath))
                {
                    var serializer = new DataContractJsonSerializer(typeof(GameVaultManifest));
                    return serializer.ReadObject(stream) as GameVaultManifest;
                }
            }
            catch (Exception exception)
            {
                error = exception.Message;
                return null;
            }
        }

        private static string GetManifestPath()
        {
            var overridePath = Environment.GetEnvironmentVariable("GAMEVAULT_PLAYNITE_MANIFEST");
            if (!string.IsNullOrWhiteSpace(overridePath))
            {
                return overridePath;
            }

            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "GameVault", "playnite-library.json");
        }

        private static string GetStatusPath()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "GameVault", "playnite-sync-status.json");
        }

        private static string GetIconDirectory()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "GameVault", "playnite-icons");
        }
    }

    [DataContract]
    public class GameVaultManifest
    {
        [DataMember(Name = "generatedAt")]
        public string GeneratedAt { get; set; }

        [DataMember(Name = "games")]
        public List<GameVaultManifestGame> Games { get; set; }
    }

    [DataContract]
    public class GameVaultManifestGame
    {
        [DataMember(Name = "executablePath")]
        public string ExecutablePath { get; set; }

        [DataMember(Name = "installPath")]
        public string InstallPath { get; set; }

        [DataMember(Name = "steamAppId")]
        public int SteamAppId { get; set; }

        [DataMember(Name = "steamStoreUrl")]
        public string SteamStoreUrl { get; set; }

        [DataMember(Name = "steamTitle")]
        public string SteamTitle { get; set; }

        [DataMember(Name = "title")]
        public string Title { get; set; }

        [DataMember(Name = "trackedItemId")]
        public string TrackedItemId { get; set; }

        [DataMember(Name = "version")]
        public string Version { get; set; }
    }

    [DataContract]
    public class GameVaultSyncStatus
    {
        [DataMember(Name = "exportableGames")]
        public int ExportableGames { get; set; }

        [DataMember(Name = "importableGames")]
        public int ImportableGames { get; set; }

        [DataMember(Name = "lastError")]
        public string LastError { get; set; }

        [DataMember(Name = "manifestGeneratedAt")]
        public string ManifestGeneratedAt { get; set; }

        [DataMember(Name = "manifestPath")]
        public string ManifestPath { get; set; }

        [DataMember(Name = "pluginVersion")]
        public string PluginVersion { get; set; }

        [DataMember(Name = "seenAt")]
        public string SeenAt { get; set; }

        [DataMember(Name = "syncedGames")]
        public int SyncedGames { get; set; }
    }
}

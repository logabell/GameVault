using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
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
        private const string PluginVersion = "0.1.6";
        private readonly IPlayniteAPI playniteApi;

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
            WriteCurrentSyncStatus();
        }

        public override void OnLibraryUpdated(OnLibraryUpdatedEventArgs args)
        {
            WriteCurrentSyncStatus();
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
                        ShouldReplaceGameIcon(game.Icon, manifestGame: null) &&
                        !string.IsNullOrWhiteSpace(game.GameId) &&
                        int.TryParse(game.GameId, out appId) &&
                        gamesById.TryGetValue(appId, out manifestGame) &&
                        File.Exists(manifestGame.ExecutablePath))
                    {
                        var iconPath = GetExecutableIconPath(manifestGame);
                        if (!string.IsNullOrWhiteSpace(iconPath) &&
                            ShouldReplaceGameIcon(game.Icon, manifestGame))
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
                var iconPath = Path.Combine(iconDirectory, game.SteamAppId + ".png");
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

        private static bool ShouldReplaceGameIcon(string currentIcon, GameVaultManifestGame manifestGame)
        {
            if (string.IsNullOrWhiteSpace(currentIcon))
            {
                return true;
            }

            if (manifestGame != null &&
                string.Equals(
                    currentIcon,
                    manifestGame.ExecutablePath,
                    StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return currentIcon.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
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

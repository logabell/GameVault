const hostName = 'com.vaulttrack.desktop';

for (const registryPath of [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`,
]) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolvePromise) => {
    const child = spawn('cmd.exe', ['/c', `reg delete "${registryPath}" /f`], {
      stdio: 'inherit',
    });
    child.on('exit', () => resolvePromise(undefined));
  });
}

console.log(`Removed native host registry entries for ${hostName}`);

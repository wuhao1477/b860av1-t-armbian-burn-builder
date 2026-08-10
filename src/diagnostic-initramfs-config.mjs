const REQUIRED_BUSYBOX_OPTIONS = [
  'STATIC', 'SH_IS_ASH', 'CAT', 'ECHO', 'HEAD', 'MKDIR', 'SLEEP', 'TRUE', 'UNAME',
  'AWK', 'MOUNT', 'SETSID', 'CTTYHACK', 'MDEV', 'HOSTNAME', 'IP',
  'FEATURE_IP_ADDRESS', 'FEATURE_IP_LINK', 'IFCONFIG', 'ROUTE', 'UDHCPC', 'HTTPD',
];

function configSymbol(line) {
  return line.match(/^CONFIG_([A-Z0-9_]+)=/u)?.[1]
    ?? line.match(/^# CONFIG_([A-Z0-9_]+) is not set$/u)?.[1];
}

export function mergeBusyboxConfig(baselineSource, fragmentSource) {
  const lines = baselineSource.split(/\r?\n/u);
  const indexes = new Map();
  for (const [index, line] of lines.entries()) {
    const name = configSymbol(line);
    if (!name) continue;
    if (indexes.has(name)) throw new Error(`BusyBox baseline repeats CONFIG_${name}`);
    indexes.set(name, index);
  }
  for (const line of fragmentSource.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^CONFIG_([A-Z0-9_]+)=y$/u);
    if (!match) throw new Error(`BusyBox fragment line is invalid: ${line}`);
    const index = indexes.get(match[1]);
    if (index === undefined) throw new Error(`BusyBox baseline is missing CONFIG_${match[1]}`);
    lines[index] = line;
  }
  return lines.join('\n');
}

function enabledOptions(source) {
  return new Set(
    source.split(/\r?\n/u)
      .map((line) => line.match(/^CONFIG_([A-Z0-9_]+)=y$/u)?.[1])
      .filter(Boolean),
  );
}

export function validateDiagnosticBuildConfiguration(busyboxSource) {
  const enabled = enabledOptions(busyboxSource);
  for (const name of REQUIRED_BUSYBOX_OPTIONS) {
    if (!enabled.has(name)) throw new Error(`BusyBox configuration is missing CONFIG_${name}=y`);
  }
  return { remoteAccess: 'http-only' };
}

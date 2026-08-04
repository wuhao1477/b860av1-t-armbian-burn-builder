export function expectedBuildInputs(manifest) {
  if (manifest.schemaVersion >= 4) {
    return {
      builder: { commit: manifest.sources.builder.commit },
      ubootSource: {
        repository: manifest.sources.ubootSource.repository,
        ref: manifest.sources.ubootSource.ref,
        commit: manifest.sources.ubootSource.commit,
      },
      firmware: { inheritedFromVerifiedBaseImage: true },
      kernel: { version: manifest.sources.kernel.version },
      bootConfiguration: { memoryLimitMiB: manifest.board.memoryLimitMiB },
      persistentBootloader: { included: false, sourceDirectoriesRemoved: true },
      fatUbootOverload: {
        included: true,
        sourceBuilt: true,
        name: manifest.board.ubootOverload,
        recipe: manifest.board.ubootOverloadBuild,
      },
      ...(manifest.schemaVersion >= 5
        ? {
          deviceTree: {
            name: manifest.board.dtb,
            recipe: manifest.board.dtbBuild,
          },
        }
        : {}),
      removedLegacyFatPayloads: ['u-boot.sd', 'u-boot.usb'],
      sanitizedPrePartitionGap: true,
    };
  }
  return {
    builder: { commit: manifest.sources.builder.commit },
    uboot: { commit: manifest.sources.uboot.commit },
    firmware: { commit: manifest.sources.firmware.commit },
    kernel: { version: manifest.sources.kernel.version },
    bootConfiguration: { memoryLimitMiB: manifest.board.memoryLimitMiB },
    persistentBootloader: { included: false, excludedName: manifest.board.mainlineBootloader },
    fatUbootOverload: {
      included: true,
      name: manifest.board.ubootOverload,
      sha256: manifest.board.ubootOverloadSha256,
      size: manifest.board.ubootOverloadSize,
    },
    removedLegacyFatPayloads: ['u-boot.sd', 'u-boot.usb'],
    sanitizedPrePartitionGap: true,
  };
}

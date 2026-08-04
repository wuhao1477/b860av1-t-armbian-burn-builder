# Security Policy

## Supported Code

Only the current `main` branch is maintained.

## Reporting

Report command injection, workflow permission, secret exposure, digest bypass, or unsafe image-validation issues through GitHub private vulnerability reporting.

Do not attach stock firmware, bootloader binaries, device keys, credentials, or private download URLs to a public issue.

## Build Trust

Release base images and kernel archives require expected SHA-256 digests; Git repositories and GitHub Actions are pinned to exact commits. Ubuntu runner and apt package versions are not digest-pinned, so builds are traceable but not bit-for-bit reproducible. A successful container check does not establish hardware boot safety.

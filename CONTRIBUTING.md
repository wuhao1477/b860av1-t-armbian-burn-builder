# Contributing

Contributions should preserve reproducibility and the hardware-validation boundary.

1. Open an issue describing the board revision, SoC marking, RAM/eMMC size, and the behavior being changed.
2. Add or update a failing automated test before implementation.
3. Run `pnpm test` and `bash -n scripts/*.sh`.
4. Do not commit vendor firmware, extracted bootloader items, device keys, Android applications, or local absolute paths.
5. Hardware-support claims require an unedited UART log from power-on through multi-user Debian, plus checks for eMMC and Ethernet.

Commits use `<type>(scope): <Chinese summary>` and remain GPG or SSH signed.

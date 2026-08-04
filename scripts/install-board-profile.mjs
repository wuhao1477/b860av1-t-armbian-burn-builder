#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function normalizedEntry(value) {
  const line = value.trim();
  const columns = line.split(':');
  if (columns.length !== 15) throw new Error('board profile entry must contain 15 columns');
  const [id, model, soc, dtb, overload, mainline, bootloader, description, kernel, platform, family, bootConfig, contributor, board, build] = columns;
  if (!/^\d+$/.test(id) || !model || !/^[a-z0-9]+$/.test(soc)
    || !/^meson-[A-Za-z0-9._-]+\.dtb$/.test(dtb)
    || !/^u-boot-[A-Za-z0-9._-]+\.bin$/.test(overload)
    || mainline !== 'NA' || bootloader !== 'NA' || !description
    || !/^[a-z]+\/(?:all|[0-9.x_y]+)$/.test(kernel)
    || platform !== 'amlogic' || family !== 'meson-gxl' || bootConfig !== 'uEnv.txt'
    || !contributor || !/^[a-z0-9][a-z0-9._-]*$/.test(board) || !/^(?:yes|no)$/.test(build)) {
    throw new Error('invalid board profile entry');
  }
  return { board, line };
}

export function installBoardProfile(database, entry) {
  if (typeof database !== 'string' || database.length === 0) throw new Error('model database is empty');
  const normalized = normalizedEntry(entry);
  const rows = database.split(/\r?\n/).filter(Boolean);
  if (rows.some((row) => row.split(':')[13] === normalized.board)) {
    throw new Error(`duplicate board profile: ${normalized.board}`);
  }
  return `${database.replace(/\s*$/, '\n')}${normalized.line}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [databasePath, entryPath] = process.argv.slice(2);
  if (!databasePath || !entryPath) {
    process.stderr.write('usage: install-board-profile.mjs model_database.conf b860av1-t-model.conf\n');
    process.exit(2);
  }
  try {
    const database = fs.readFileSync(databasePath, 'utf8');
    const entry = fs.readFileSync(entryPath, 'utf8');
    fs.writeFileSync(databasePath, installBoardProfile(database, entry));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

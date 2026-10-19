/**
 * `nanomind setup`: puts the llamafile and the model that @nanomind/engine
 * runs at the paths the engine reads by default, so that the engine's first
 * call has nothing to download. The interactive session uses neither file.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  LLAMAFILE_DOWNLOAD,
  MODEL_DOWNLOAD,
  defaultLlamafilePath,
  defaultModelPath,
  downloadVerified,
  sha256File,
  type DownloadSource,
} from './download.ts';

export interface SetupOptions {
  /** The directory .nanomind goes in. Defaults to the user's home directory. */
  home?: string;
  /** Where the llamafile is downloaded from. Defaults to LLAMAFILE_DOWNLOAD. */
  llamafileDownload?: DownloadSource;
  /** Where the model is downloaded from. Defaults to MODEL_DOWNLOAD. */
  modelDownload?: DownloadSource;
  /** Prints one line. Defaults to console.log. */
  print?: (line: string) => void;
}

/**
 * Put the llamafile and the model at the engine's default paths. A file that
 * is already at its path is not downloaded again: it is kept when its SHA-256
 * is the one pinned for it, and otherwise left as it is and named. A missing
 * file is downloaded and checked by downloadVerified. Resolves to true when
 * both files are in place with their pinned SHA-256, and to false when a file
 * that was already there has another one. Rejects when a download fails.
 */
export async function runSetup(options: SetupOptions = {}): Promise<boolean> {
  const home = options.home ?? homedir();
  const print = options.print ?? ((line: string) => console.log(line));
  const files = [
    {
      name: 'llamafile',
      path: defaultLlamafilePath(home),
      source: options.llamafileDownload ?? LLAMAFILE_DOWNLOAD,
      mode: 0o755,
    },
    {
      name: 'model',
      path: defaultModelPath(home),
      source: options.modelDownload ?? MODEL_DOWNLOAD,
      mode: 0o644,
    },
  ];

  let verified = true;
  for (const file of files) {
    if (existsSync(file.path)) {
      const sha256 = await sha256File(file.path);
      if (sha256 === file.source.sha256) {
        print(`${file.name}: ${file.path} is already there, SHA-256 verified`);
      } else {
        verified = false;
        print(
          `${file.name}: ${file.path} is already there, but its SHA-256 is ${sha256}, not the pinned ${file.source.sha256}. ` +
            'Setup leaves it as it is. Delete it and run nanomind setup again to download the pinned file.',
        );
      }
      continue;
    }
    print(`${file.name}: downloading ${file.source.size} bytes from ${file.source.url}`);
    await downloadVerified(file.source, file.path, file.mode);
    print(`${file.name}: saved ${file.path}, SHA-256 verified`);
  }
  return verified;
}

import { Client } from 'ssh2';
import { readdirSync, statSync } from 'fs';
import { join, posix } from 'path';

import { connectOptions } from './config';
const [localRoot, remoteRoot] = process.argv.slice(2);
if (!localRoot || !remoteRoot) {
	console.error('usage: bun run tools/upload-dir.ts <localDir> <remoteDir>');
	process.exit(1);
}

type Entry = { local: string; remote: string };
const files: Entry[] = [];
const dirs: string[] = [remoteRoot];

const walk = (l: string, r: string) => {
	for (const name of readdirSync(l)) {
		if (name === '.DS_Store') continue;
		const lp = join(l, name);
		const rp = posix.join(r, name);
		if (statSync(lp).isDirectory()) {
			dirs.push(rp);
			walk(lp, rp);
		} else {
			files.push({ local: lp, remote: rp });
		}
	}
};
walk(localRoot, remoteRoot);
console.log(`${dirs.length} dirs, ${files.length} files`);

const conn = new Client();
conn.on('ready', () => {
	conn.sftp((err, sftp) => {
		if (err) throw err;

		const mkdirs = (i: number, next: () => void) => {
			if (i >= dirs.length) return next();
			sftp.mkdir(dirs[i], () => mkdirs(i + 1, next)); // EEXIST ignored
		};

		const puts = (i: number) => {
			if (i >= files.length) {
				console.log('done');
				conn.end();
				return;
			}
			sftp.fastPut(files[i].local, files[i].remote, e => {
				if (e) {
					console.error(`FAILED ${files[i].remote}: ${e.message}`);
					conn.end();
					process.exit(1);
				}
				console.log(`ok ${files[i].remote}`);
				puts(i + 1);
			});
		};

		mkdirs(0, () => puts(0));
	});
});
conn.on('error', e => {
	console.error('ssh error:', e.message);
	process.exit(1);
});
conn.connect(connectOptions());

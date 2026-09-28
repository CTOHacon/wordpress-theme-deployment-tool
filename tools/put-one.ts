import { Client } from 'ssh2';

import { connectOptions } from './config';
const [localPath, remotePath] = process.argv.slice(2);
if (!localPath || !remotePath) {
	console.error('usage: bun run tools/put-one.ts <local> <remote>');
	process.exit(1);
}

const conn = new Client();

conn.on('ready', () => {
	conn.sftp((err, sftp) => {
		if (err) throw err;

		const dir = remotePath.replace(/\/[^/]+$/, '');
		const base = remotePath.split('/').pop()!;
		const stem = base.replace(/\.[^.]+$/, '');

		sftp.readdir(dir, (dirErr, list) => {
			if (dirErr) {
				console.error('readdir failed:', dirErr.message);
			} else {
				const related = list
					.filter(e => e.filename.startsWith(stem.slice(0, 20)))
					.map(e => `${e.filename} (${e.attrs.size}B)`);
				console.log('siblings matching stem:\n  ' + related.join('\n  '));
			}

			sftp.fastPut(localPath, remotePath, putErr => {
				if (putErr) {
					console.error('upload FAILED:', putErr.message);
					conn.end();
					process.exit(1);
				}
				sftp.stat(remotePath, (statErr, stats) => {
					if (statErr) console.error('stat failed:', statErr.message);
					else console.log(`uploaded ${remotePath} — ${stats.size} bytes`);
					conn.end();
				});
			});
		});
	});
});

conn.on('error', e => {
	console.error('ssh error:', e.message);
	process.exit(1);
});

conn.connect(connectOptions());

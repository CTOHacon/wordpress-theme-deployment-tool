import { Client } from 'ssh2';
import { readFileSync } from 'fs';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const remotePath = process.argv[2];
if (!remotePath) {
	console.error('usage: bun run rm-one.ts <remotePath>');
	process.exit(1);
}

const conn = new Client();

conn.on('ready', () => {
	conn.sftp((err, sftp) => {
		if (err) throw err;
		sftp.unlink(remotePath, unlinkErr => {
			if (unlinkErr) {
				console.error('unlink FAILED:', unlinkErr.message);
				conn.end();
				process.exit(1);
			}
			sftp.stat(remotePath, statErr => {
				console.log(statErr ? `deleted ${remotePath} (gone)` : `WARNING: ${remotePath} still present`);
				conn.end();
			});
		});
	});
});

conn.on('error', e => {
	console.error('ssh error:', e.message);
	process.exit(1);
});

conn.connect(cfg.ssh);

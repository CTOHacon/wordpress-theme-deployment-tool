// Shared config loader for the one-off tools in this folder.
// Reads ../config.json and turns its `ssh` block into ssh2 ConnectConfig —
// `privateKey` in config.json is a PATH, ssh2 wants the key CONTENTS.
import { readFileSync } from 'fs';
import type { ConnectConfig } from 'ssh2';

export const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

// WordPress root on the server: `remote_wp_root`, or derived from the theme path.
export const remoteWpRoot: string =
	cfg.remote_wp_root || String(cfg.remote_theme_path).replace(/\/wp-content\/.*$/, '');

export const connectOptions = (): ConnectConfig => {
	const { host, port = 22, username, password, privateKey, passphrase } = cfg.ssh;
	const opts: ConnectConfig = { host, port, username, keepaliveInterval: 10000 };
	if (privateKey) {
		opts.privateKey = readFileSync(privateKey);
		if (passphrase) opts.passphrase = passphrase;
	} else if (password) {
		opts.password = password;
	}
	return opts;
};

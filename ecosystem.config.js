const requiredEnv = (name) => {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} must be set in the process environment before starting POS`);
	}
	return value;
};

module.exports = {
	apps: [
		{
			name: 'jingles-pos-backend',
			script: './packages/backend/dist/server.js',
			cwd: '/var/www/federation-inventory/jingles-pos',
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: '1G',
			env: {
				NODE_ENV: 'production',
				PORT: 3050,
				DATABASE_URL: process.env.DATABASE_URL || 'file:/var/www/federation-inventory/jingles-pos/data/jingles.db',
				JINGLES_POS_LOCAL_MODE: 'true',
				JINGLES_POS_UPSTREAM_URL: process.env.JINGLES_POS_UPSTREAM_URL || 'https://inv.theredsun.org',
				JINGLES_POS_SYNC_APP_TOKEN: requiredEnv('JINGLES_POS_SYNC_APP_TOKEN'),
			},
		},
	],
};

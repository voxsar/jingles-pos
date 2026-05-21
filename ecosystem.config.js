module.exports = {
	apps: [
		{
			name: 'jingles-pos-backend',
			script: './packages/backend/dist/server.js',
			cwd: '/var/www/jingles-pos',
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: '512M',
			env: {
				NODE_ENV: 'production',
				PORT: 3050,
				DATABASE_URL: 'file:/var/www/jingles-pos/data/jingles.db',
				JINGLES_POS_LOCAL_MODE: 'true',
				JINGLES_POS_UPSTREAM_URL: 'https://inv.theredsun.org',
				JINGLES_POS_SYNC_APP_TOKEN: 'uxo2F4ZOUgM08520vBo0hTPtTS09I50CIQbOAuZ',
			},
		},
	],
};

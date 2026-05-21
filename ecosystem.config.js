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
			},
		},
	],
};

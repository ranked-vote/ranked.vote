import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 3000
	},
	ssr: {
		external: ['better-sqlite3']
	},
	build: {
		rollupOptions: {
			onwarn(warning, warn) {
				// Suppress the @__PURE__ annotation warning from Rollup
				if (warning.message.includes('@__PURE__')) {
					return;
				}
				warn(warning);
			}
		}
	}
});


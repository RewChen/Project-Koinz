import type { Config } from 'tailwindcss';
export default { content: ['./src/**/*.{ts,tsx}'], theme: { extend: { colors: { ink: '#0B0F19', panel: '#111827', mint: '#26E6A3', aqua: '#30D5E8' }, boxShadow: { glow: '0 0 32px rgba(38,230,163,.16)' } } }, plugins: [] } satisfies Config;

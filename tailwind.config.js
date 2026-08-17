/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: 'class',
    content: ['./index.html', './renderer.js'],
    theme: {
        extend: {
            colors: {
                dark: { 900: '#1e1e1e', 800: '#2a2a2a', 700: '#333333', 600: '#444444' },
                light: { 100: '#f8f9fa', 200: '#f1f3f5', 300: '#e9ecef', 400: '#dee2e6', 500: '#ced4da' },
                brand: { DEFAULT: '#9eff2f', hover: '#8be525', light: '#d4ed8a' },
                text: { muted: '#9ca3af' }
            },
            fontFamily: { sans: ['Inter', 'sans-serif'] },
            boxShadow: {
                'glow': '0 0 15px rgba(158, 255, 47, 0.5)',
                'card': '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)',
                'light-card': '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
            }
        }
    }
};

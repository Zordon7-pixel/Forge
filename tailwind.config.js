/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        forge: {
          bg: '#0f1117',
          card: '#171c27',
          accent: '#EAB308',
          text: '#FFFFFF',
          subtext: '#94a3b8',
          border: '#2c3345'
        }
      }
    }
  },
  plugins: []
};

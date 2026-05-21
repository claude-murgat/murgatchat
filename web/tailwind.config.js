/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        aubergine: {
          DEFAULT: "#3F0E40",
          900: "#19171D",
          800: "#350D36",
          700: "#3F0E40",
          600: "#522653",
          500: "#6B3A6B",
          400: "#BCABBC",
        },
        slackblue: "#1264A3",
        slackgreen: "#007a5a",
        slackred: "#E01E5A",
      },
      fontFamily: {
        sans: [
          "Slack-Lato",
          "Lato",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

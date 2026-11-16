/**
 * The one place the backend's base URL is decided.
 *
 * `VITE_API_BASE_URL` is baked in at build time and documented in `.env.example`; the localhost
 * default is what the development server and the dev backend use, so a checkout with no `.env`
 * still works. Every module imports this instead of repeating the expression, so a deployment
 * changes one value.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

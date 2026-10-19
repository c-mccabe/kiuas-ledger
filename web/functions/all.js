// Server-rendered pages; see src/seo.js.
import { handle } from '../src/seo.js';

export const onRequestGet = ({ request, env }) => handle(request, env);

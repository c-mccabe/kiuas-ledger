// Pages Functions entry for every /api/* path; the routing lives in the worker.
import worker from '../../src/worker.js';

export const onRequest = ({ request, env }) => worker.fetch(request, env);

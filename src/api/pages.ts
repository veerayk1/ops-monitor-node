import { Router } from 'express';

export const pagesRouter = Router();

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

pagesRouter.get('/', (_req, res) => {
  res.render('dashboard', { active: 'dashboard' });
});

pagesRouter.get('/builder', (_req, res) => {
  res.render('builder', { active: 'builder', jobId: null });
});

pagesRouter.get('/builder/:jobId', (req, res) => {
  const jobId = parseId(req.params.jobId);
  if (!jobId) return res.status(400).send('Invalid job ID');
  res.render('builder', { active: 'builder', jobId });
});

pagesRouter.get('/runs/:runId', (req, res) => {
  const runId = parseId(req.params.runId);
  if (!runId) return res.status(400).send('Invalid run ID');
  res.render('run_detail', { active: 'dashboard', runId });
});

pagesRouter.get('/settings', (_req, res) => {
  res.render('settings', { active: 'settings' });
});

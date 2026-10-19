const DISPATCH = 'https://api.github.com/repos/c-mccabe/kiuas-ledger/actions/workflows/scrape.yml/dispatches';

export default {
  async scheduled(event, env) {
    const t = new Date(event.scheduledTime);
    // Same archive slot as the workflow's ARCHIVE schedule: :45 of odd hours, 05–21 UTC.
    const archive = t.getUTCMinutes() === 45 && t.getUTCHours() % 2 === 1 && t.getUTCHours() <= 21;
    const res = await fetch(DISPATCH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sauna-finder-cron',
      },
      body: JSON.stringify({ ref: 'main', inputs: { archive: String(archive) } }),
    });
    if (!res.ok) throw new Error(`dispatch: HTTP ${res.status} ${await res.text()}`);
    console.log(`dispatched (archive=${archive})`);
  },
};

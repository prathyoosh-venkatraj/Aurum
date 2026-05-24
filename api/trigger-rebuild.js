export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.GITHUB_REBUILD_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Rebuild token not configured on server' });
  }

  const response = await fetch(
    'https://api.github.com/repos/F1nV4ult/Aurum/actions/workflows/rebuild-portfolios.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return res.status(502).json({ error: `GitHub API returned ${response.status}`, detail });
  }

  return res.status(200).json({ ok: true });
}

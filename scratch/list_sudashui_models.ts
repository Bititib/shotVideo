import Database from 'better-sqlite3';
import path from 'path';

async function querySudaShuiModels() {
  const dbPath = path.resolve('data/app.db');
  try {
    const sqlite = new Database(dbPath);
    const channel = sqlite.prepare("SELECT api_key, base_url FROM channels WHERE base_url LIKE '%sudashui%'").get() as any;
    sqlite.close();

    if (!channel) {
      console.log('No SudaShui channel found.');
      return;
    }

    const baseUrl = channel.base_url.replace(/\/+$/, '');
    console.log(`Querying ${baseUrl}/v1/models ...`);
    const resp = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${channel.api_key}`
      }
    });

    if (!resp.ok) {
      console.log(`Error: HTTP ${resp.status} ${await resp.text()}`);
      return;
    }

    const data = await resp.json() as any;
    console.log('--- SudaShui Model IDs ---');
    const ids = data.data.map((m: any) => m.id);
    console.log(ids.join('\n'));
  } catch (err: any) {
    console.error(err);
  }
}

querySudaShuiModels();

import { db } from '../server/db';
import { contents } from '../server/db/schema';
import { desc } from 'drizzle-orm';

function queryLastTasks() {
  const lastTask = db.select().from(contents).orderBy(desc(contents.createdAt)).limit(1).get();
  if (lastTask) {
    console.log(`ID: ${lastTask.id}, Model: ${lastTask.model}, Status: ${lastTask.status}`);
    console.log(`Prompt: ${lastTask.prompt}`);
    console.log(`CreatedAt: ${lastTask.createdAt}`);
    console.log(`ErrorMsg: ${lastTask.errorMsg}`);
    try {
      const meta = JSON.parse(lastTask.metadata || '{}');
      console.log('Metadata Info:');
      console.log(`- resolution: ${meta.resolution}`);
      console.log(`- seconds: ${meta.seconds}`);
      console.log(`- aspect_ratio: ${meta.aspect_ratio}`);
      console.log(`- model: ${meta.model}`);
      console.log(`- reference_images count: ${meta.reference_images?.length || 0}`);
      console.log(`- reference_videos count: ${meta.reference_videos?.length || 0}`);
      console.log(`- audio_urls count: ${meta.audio_urls?.length || 0}`);
    } catch {
      console.log('Metadata (Raw):', lastTask.metadata?.slice(0, 100));
    }
  }
}

queryLastTasks();

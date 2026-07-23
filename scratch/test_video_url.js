async function test() {
  const url = 'https://llm.chre3.com/v1/videos/task_D0cZhJXnY8clk5r8VvUdZZylJWzZH5II/content';
  const headers = {
    'Authorization': 'Bearer sk-jONZxfxNTSIMij2f7CgUIIdZjQkCmadK8nG51dHa3WcZMvgG'
  };

  console.log('--- Test 1: Fetching WITH Authorization header ---');
  try {
    const res = await fetch(url, { headers });
    console.log(`Status: ${res.status}`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);
    console.log(`Content-Length: ${res.headers.get('content-length')}`);
    const text = await res.text();
    console.log(`Body (first 500 chars): ${text.slice(0, 500)}`);
  } catch (e) {
    console.error(e);
  }

  console.log('\n--- Test 2: Fetching WITHOUT Authorization header ---');
  try {
    const res = await fetch(url);
    console.log(`Status: ${res.status}`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);
    console.log(`Content-Length: ${res.headers.get('content-length')}`);
    const text = await res.text();
    console.log(`Body (first 500 chars): ${text.slice(0, 500)}`);
  } catch (e) {
    console.error(e);
  }
}

test();

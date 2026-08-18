async function getModels() {
  const baseUrl = 'https://mjnewapi.diwdiw.cn';
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    console.log(`Status: ${res.status}`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error(err.message);
  }
}

getModels();

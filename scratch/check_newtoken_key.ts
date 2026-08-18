async function checkNewToken() {
  const baseUrl = 'https://newtoken.club';
  const apiKey = 'sk-22Vcwozkj2VvDsiTqr988NElCXPoTLFXg4tWWrGdYAWxac5o';

  console.log('Checking subscription/balance on newtoken.club...');
  try {
    const res = await fetch(`${baseUrl}/v1/dashboard/billing/subscription`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    console.log(`Status: ${res.status}`);
    const data = await res.json();
    console.log(`Response:`, JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error(`Error checking key:`, err.message);
  }
}

checkNewToken().catch(console.error);

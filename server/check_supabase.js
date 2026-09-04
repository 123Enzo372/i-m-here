require('dotenv').config();

function mask(value) {
  if (!value) return 'empty';
  return `${value.slice(0, 14)}...${value.slice(-6)} (${value.length} chars)`;
}

async function testKey(name, value) {
  if (!value) {
    console.log(`${name}: missing`);
    return false;
  }

  const url = `${process.env.SUPABASE_URL}/rest/v1/users?select=id,discord_webhook_url&limit=1`;
  const response = await fetch(url, {
    headers: {
      apikey: value,
      Authorization: `Bearer ${value}`,
      'User-Agent': 'presence-server-config-check'
    }
  });
  const body = await response.text();

  if (response.ok) {
    console.log(`${name}: OK`);
    return true;
  }

  console.log(`${name}: failed (${response.status}) ${body.slice(0, 160)}`);
  return false;
}

(async () => {
  console.log('SUPABASE_URL:', mask(process.env.SUPABASE_URL || ''));
  console.log('SUPABASE_SECRET_KEY:', mask(process.env.SUPABASE_SECRET_KEY || ''));
  console.log('SUPABASE_SERVICE_ROLE_KEY:', mask(process.env.SUPABASE_SERVICE_ROLE_KEY || ''));

  if (!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is missing.');
  }

  const serviceRoleOk = await testKey('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
  const secretOk = await testKey('SUPABASE_SECRET_KEY', process.env.SUPABASE_SECRET_KEY);

  if (!serviceRoleOk && !secretOk) {
    process.exitCode = 1;
    console.log('');
    console.log('No valid server key found. Use a Secret key (sb_secret_...) or the legacy service_role key from the same Supabase project.');
  } else {
    console.log('Schema check: users.discord_webhook_url is readable.');
  }
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});

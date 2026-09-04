import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const DAY_MS = 24 * 60 * 60 * 1000;

type UserRow = {
  id: string;
  username: string;
  email: string | null;
  discord_webhook_url: string | null;
  last_seen: number | string | null;
  last_notified: number | string | null;
};

function env(name: string): string | undefined {
  return Deno.env.get(name) || undefined;
}

function readInactivityDays(): number {
  const days = Number.parseInt(env("INACTIVITY_DAYS") || "", 10);
  return Number.isNaN(days) ? 7 : days;
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getInactiveDays(lastSeen: number | string | null): number {
  return Math.floor((Date.now() - Number(lastSeen || 0)) / DAY_MS);
}

function redactEmail(email: string | null): string | null {
  return email ? email.replace(/(^.).*(@.*$)/, "$1***$2") : null;
}

function getSupabaseSecretKey(): string {
  const secretKeys = env("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const parsed = JSON.parse(secretKeys);
    if (parsed.default) return parsed.default;
  }

  const legacyServiceRole = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyServiceRole) return legacyServiceRole;

  const localSecretKey = env("SUPABASE_SECRET_KEY");
  if (localSecretKey) return localSecretKey;

  throw new Error("Supabase secret key missing.");
}

const supabase = createClient(env("SUPABASE_URL")!, getSupabaseSecretKey(), {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

async function updateUser(id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("users").update(values).eq("id", id);
  if (error) throw error;
}

async function sendDiscordInactivityMessage(user: UserRow, inactiveDays: number): Promise<boolean> {
  const webhookUrl = user.discord_webhook_url || env("WEBHOOK_URL");
  if (!webhookUrl) {
    console.warn(`[DISCORD] Webhook absent pour ${user.username}, message d'inactivite non envoye.`);
    return false;
  }

  const dayLabel = inactiveDays > 1 ? "jours" : "jour";
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "PresenceBot",
      embeds: [{
        title: "Inactivite detectee",
        description: `${user.username} est inactif depuis ${inactiveDays} ${dayLabel}.`,
        fields: [
          { name: "Utilisateur", value: user.username, inline: true },
          { name: "Inactivite", value: `${inactiveDays} ${dayLabel}`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook HTTP ${response.status}`);
  }

  return true;
}

async function sendInactivityEmail(user: UserRow): Promise<boolean> {
  if (!user.email) return false;

  const smtpUser = env("SMTP_USER");
  const smtpPass = env("SMTP_PASS");
  if (!smtpUser || !smtpPass) {
    console.warn(`[MAIL] SMTP non configure, mail final non envoye a ${redactEmail(user.email)}.`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: env("SMTP_HOST") || "smtp.gmail.com",
    port: Number.parseInt(env("SMTP_PORT") || "587", 10),
    secure: false,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  await new Promise<void>((resolve, reject) => {
    transporter.sendMail(
      {
        from: `"Presence App" <${smtpUser}>`,
        to: user.email!,
        subject: env("INACTIVITY_EMAIL_SUBJECT") || "Absence detectee",
        text: env("INACTIVITY_EMAIL_MESSAGE") ||
          "Bonjour, vous ne vous etes pas connecte depuis plusieurs jours.",
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });

  return true;
}

async function processInactiveUsers() {
  const maxInactivityDays = readInactivityDays();
  const todayStart = startOfToday();
  const summary = {
    checked: 0,
    discordSent: 0,
    emailSent: 0,
    disabled: 0,
    skipped: 0,
    notifiedToday: 0,
    errors: [] as string[],
    debugUsers: [] as Array<{
      username: string;
      inactiveDays: number;
      action: string;
      lastNotifiedToday: boolean;
      hasEmail: boolean;
      hasDiscordWebhook: boolean;
    }>,
  };

  const { data: users, error } = await supabase
    .from("users")
    .select("id, username, email, discord_webhook_url, last_seen, last_notified")
    .not("last_seen", "is", null)
    .eq("notifications_disabled", false);

  if (error) throw error;

  for (const user of (users || []) as UserRow[]) {
    summary.checked += 1;
    const inactiveDays = getInactiveDays(user.last_seen);
    const lastNotifiedToday = (Number(user.last_notified) || 0) >= todayStart;

    if (inactiveDays > maxInactivityDays) {
      await updateUser(user.id, { notifications_disabled: true });
      summary.disabled += 1;
      summary.debugUsers.push({
        username: user.username,
        inactiveDays,
        action: "disabled_without_send_after_limit",
        lastNotifiedToday,
        hasEmail: Boolean(user.email),
        hasDiscordWebhook: Boolean(user.discord_webhook_url || env("WEBHOOK_URL")),
      });
      continue;
    }

    if (inactiveDays < 1 || inactiveDays > maxInactivityDays) {
      summary.skipped += 1;
      summary.debugUsers.push({
        username: user.username,
        inactiveDays,
        action: "skipped_not_in_inactivity_window",
        lastNotifiedToday,
        hasEmail: Boolean(user.email),
        hasDiscordWebhook: Boolean(user.discord_webhook_url || env("WEBHOOK_URL")),
      });
      continue;
    }

    if (lastNotifiedToday) {
      summary.notifiedToday += 1;
      summary.debugUsers.push({
        username: user.username,
        inactiveDays,
        action: "skipped_already_notified_today",
        lastNotifiedToday,
        hasEmail: Boolean(user.email),
        hasDiscordWebhook: Boolean(user.discord_webhook_url || env("WEBHOOK_URL")),
      });
    } else {
      try {
        if (await sendDiscordInactivityMessage(user, inactiveDays)) {
          summary.discordSent += 1;
          await updateUser(user.id, { last_notified: Date.now() });
          summary.debugUsers.push({
            username: user.username,
            inactiveDays,
            action: "discord_sent",
            lastNotifiedToday,
            hasEmail: Boolean(user.email),
            hasDiscordWebhook: Boolean(user.discord_webhook_url || env("WEBHOOK_URL")),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`discord:${user.username}:${message}`);
        summary.debugUsers.push({
          username: user.username,
          inactiveDays,
          action: "discord_error",
          lastNotifiedToday,
          hasEmail: Boolean(user.email),
          hasDiscordWebhook: Boolean(user.discord_webhook_url || env("WEBHOOK_URL")),
        });
        console.error(`[DISCORD] ${user.username}:`, message);
      }
    }

    if (inactiveDays >= maxInactivityDays) {
      try {
        if (await sendInactivityEmail(user)) {
          summary.emailSent += 1;
        }
        await updateUser(user.id, {
          notifications_disabled: true,
          last_email_sent: Date.now(),
        });
        summary.disabled += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`mail:${redactEmail(user.email)}:${message}`);
        console.error(`[MAIL] ${redactEmail(user.email)}:`, message);
      }
    }
  }

  return summary;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const cronSecret = env("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    if (body?.testDiscord === true) {
      const sent = await sendDiscordInactivityMessage({
        id: "test",
        username: "test-presence",
        email: null,
        discord_webhook_url: null,
        last_seen: Date.now() - DAY_MS,
        last_notified: 0,
      }, 1);
      return Response.json({
        ok: true,
        testDiscord: sent,
        hasWebhookUrl: Boolean(env("WEBHOOK_URL")),
      });
    }

    const summary = await processInactiveUsers();
    return Response.json({ ok: true, summary });
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "unknown_error" },
      { status: 500 },
    );
  }
});

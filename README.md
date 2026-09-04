# i-m-here
Application Presence: un client Electron, un serveur Node local et une base Supabase.

Chaque utilisateur configure son propre webhook Discord dans l'application. Les secrets serveur et Supabase restent hors du client Electron.

## Configuration Supabase

1. Dans Supabase, ouvre ton projet.
2. Va dans **SQL Editor**.
3. Copie-colle le contenu de `server/supabase_schema.sql`.
4. Clique sur **Run** pour créer les tables `users` et `refresh_tokens`.
5. Va dans **Project Settings > API Keys**.
6. Copie l'URL du projet dans `server/.env`:

```env
SUPABASE_URL=https://ton-project-ref.supabase.co
```

7. Copie une clé serveur dans `server/.env`:

```env
SUPABASE_SECRET_KEY=...
```

Si ton dashboard affiche seulement les anciennes clés, mets la clé `service_role` ici:

```env
SUPABASE_SERVICE_ROLE_KEY=...
```

Ne mets jamais cette clé dans le client Electron.

Si le serveur affiche `Invalid API key`, vérifie ces points:

- `SUPABASE_URL` et la clé doivent venir du même projet Supabase.
- Copie la valeur complète de la clé, pas son nom ni son identifiant.
- Si `SUPABASE_SECRET_KEY=sb_secret_...` ne passe pas, mets la clé legacy `service_role` dans `SUPABASE_SERVICE_ROLE_KEY=...`; le serveur l'utilisera en priorité.
- Ne mets pas la clé `anon` / `publishable` dans `SUPABASE_SECRET_KEY`.
- Redémarre le serveur après chaque changement de `.env`.

Si `npm run check:supabase` affiche `permission denied`, `code 42501` ou une erreur de colonne manquante, retourne dans **SQL Editor** et relance `server/supabase_schema.sql`. Les lignes `grant ... to service_role` donnent au serveur les droits nécessaires sur les tables.

### Alertes Security Advisor

Si Supabase affiche des alertes comme:

- `Extension in Public` pour `public.pg_net`;
- `Public Can Execute SECURITY DEFINER Function`;
- `Signed-In Users Can Execute SECURITY DEFINER Function`;

lance `supabase/security_cleanup.sql` dans **SQL Editor**, puis relance le Security Advisor.

Si l'alerte `public.pg_net` reste, c'est probablement parce que l'extension n'est pas relocatable sur ton projet Supabase. Dans ce cas, le script indique deux options: demander au support Supabase de la déplacer, ou supprimer/recréer `pg_net` puis relancer `supabase/schedule_inactivity_cron.sql`.

### Comptes déjà créés

Le schéma ajoute `discord_webhook_url` sur les utilisateurs. Pour conserver le comportement des comptes déjà créés, garde ton webhook Discord actuel dans `WEBHOOK_URL` côté serveur puis démarre le serveur une fois: il remplira automatiquement les comptes qui n'ont pas encore de webhook.

Tu peux aussi le faire manuellement dans **SQL Editor**:

```sql
update public.users
set discord_webhook_url = 'https://discord.com/api/webhooks/TON_WEBHOOK'
where discord_webhook_url is null;
```

Ne commit jamais un vrai webhook Discord.

## Lancer l'application

Installe les dépendances une fois:

```bash
cd server
npm install
cd ../client
npm install
cd ..
```

Puis lance tout avec une seule commande:

```bash
npm start
```

Le client Electron démarre automatiquement le serveur Node en arrière-plan. L'app continue d'appeler le backend sur `http://localhost:3000`; seul le serveur parle à Supabase.

Tu peux encore lancer le serveur seul pour diagnostiquer une API:

```bash
cd server
npm start
```

## Créer un exécutable

Depuis la racine du projet:

```bash
npm run dist:win
```

L'exécutable Electron embarque le dossier serveur comme ressource, mais pas ton fichier `.env`. Pour une version packagée, copie `server.env.example` en `server.env` à côté de l'exécutable, puis remplis les valeurs.

Pour forcer un autre chemin de configuration:

```powershell
$env:PRESENCE_SERVER_ENV="C:\chemin\vers\server.env"
```

## Configuration dans l'application

Après inscription ou connexion:

- l'adresse e-mail reste facultative;
- le webhook Discord est obligatoire;
- l'enregistrement du webhook envoie un message de test dans le salon Discord;
- l'écran principal n'est accessible qu'après l'enregistrement du webhook Discord.

Depuis l'écran principal, le bouton **Webhook Discord** permet de remplacer le webhook du compte.

## Notifications sans ordinateur allumé

Le serveur local utilise Supabase comme base distante, mais pour envoyer Discord/mail même quand ton ordinateur est éteint, il faut déployer l'Edge Function `inactivity-cron`.

### Secrets Edge Function

Dans Supabase, va dans **Edge Functions > Secrets** et ajoute:

```env
INACTIVITY_DAYS=7
INACTIVITY_EMAIL_SUBJECT=Nous avons remarqué votre absence !
INACTIVITY_EMAIL_MESSAGE=Bonjour, cela fait 7 jours que vous ne vous êtes pas connecté à l'application de présence. Tout va bien ?
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=ton-email@gmail.com
SMTP_PASS=ton-mot-de-passe-app
CRON_SECRET=une-valeur-longue-aleatoire
```

Supabase fournit automatiquement `SUPABASE_URL` et les clés serveur aux Edge Functions. Si ton projet est ancien et ne fournit pas encore `SUPABASE_SECRET_KEYS`, ajoute aussi `SUPABASE_SERVICE_ROLE_KEY` dans ces secrets.

`WEBHOOK_URL` est maintenant optionnel dans les secrets Edge Function. Il sert seulement de fallback pour d'anciens comptes sans webhook en base et pour le test `{ "testDiscord": true }`:

```env
WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### Déployer la fonction

Depuis la racine du projet:

```bash
npx supabase login
npx supabase link --project-ref ton-project-ref
npx supabase functions deploy inactivity-cron
```

### Planifier tous les jours

Dans Supabase, ouvre **SQL Editor**, puis utilise `supabase/schedule_inactivity_cron.sql`.

Avant de lancer le SQL, remplace:

```sql
https://<project-ref>.supabase.co
<publishable-or-anon-key>
<same-value-as-CRON_SECRET>
```

Tu peux relancer ce script plusieurs fois: il mettra à jour les secrets Vault existants et recréera le job cron `presence-inactivity-daily`.

Le cron appelle ensuite la fonction tous les jours à minuit. La fonction envoie Discord sur le webhook du compte de J+1 à J+7 inclus, envoie le mail seulement à J+7, puis désactive les notifications au-delà.

Si tu ne reçois rien, lance `supabase/test_inactivity_cron.sql` dans **SQL Editor**. Ce test appelle la fonction avec `{ "testDiscord": true }`, puis lit `net._http_response` pour afficher le vrai statut HTTP et le contenu de réponse.

Pour lancer une vraie passe d'inactivité tout de suite, utilise `supabase/run_inactivity_cron_once.sql`. Il appelle la fonction avec les secrets Vault et sans `testDiscord`.

### Tester l'envoi Discord seul

Après avoir redéployé `inactivity-cron`, tu peux tester uniquement le webhook Discord, sans dépendre des dates en base:

```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "https://TON_PROJECT_REF.supabase.co/functions/v1/inactivity-cron" `
  -Headers @{ "x-cron-secret" = "TA_VALEUR_CRON_SECRET"; "Content-Type" = "application/json" } `
  -Body '{ "testDiscord": true }'
```

Réponse attendue:

```json
{
  "ok": true,
  "testDiscord": true,
  "hasWebhookUrl": true
}
```

Si `hasWebhookUrl` vaut `false`, ajoute `WEBHOOK_URL` dans **Edge Functions > Secrets** puis redéploie ou relance la fonction.

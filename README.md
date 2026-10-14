# Concierto CI/CD prototype

One local page for Jenkins, GitHub Actions, and Azure DevOps. It publishes pipeline definitions out to those engines and syncs their pipelines and run status back in.

Run it on **WinTest_DND**, the Windows machine where Jenkins is installed. The browser and this server stay on that machine. The page is served at `http://127.0.0.1:8088`.

Credentials are written to `creds.json` on that machine's Desktop (OneDrive Desktop if that folder exists). The Credential Manager screen shows the exact path.

## 1. Install Node.js

Install Node.js 18 or newer on WinTest_DND: https://nodejs.org/en/download

Close and reopen any command window after the installer finishes. Check with:

```bat
node -v
```

## 2. Start the prototype

Copy this `cicd` folder onto WinTest_DND if it is not already there (OneDrive Desktop sync will do that when both machines use the same account).

Double-click `start-concierto-cicd.bat`.

Open a browser **on that same machine** and go to:

```text
http://127.0.0.1:8088
```

Leave the command window open while you use the page.

## 3. Jenkins API token

1. On WinTest_DND, open Jenkins and sign in as the user that should create and run jobs (your admin user is fine for the prototype).
2. Click your name at the top right.
3. Open **Security** (on older Jenkins this is **Configure**).
4. Under **API Token**, choose **Add new token**, name it `Concierto`, and generate it.
5. Copy the token immediately. Jenkins shows it only once.
6. In Concierto, open **CI/CD → Credential Manager**.
7. Set Jenkins URL to `http://127.0.0.1:8080` if Jenkins is on the default port. Change the port if yours is different.
8. Username is the Jenkins user. Paste the **API token**, not the login password.
9. Leave the agent shell on **bat** for the Windows agent.
10. Click **Save and test Jenkins**. You should see how many jobs are visible.

The Jenkins user needs permission to read jobs, create jobs, and build them. An admin account already has that.

If Jenkins was installed with a context path, include it in the URL, for example `http://127.0.0.1:8080/jenkins`.

## 4. GitHub token and repositories

Create a personal access token on the GitHub account that is signed in on WinTest_DND:

- Classic token scopes: **repo** and **workflow**
- Fine-grained token: Contents **read and write**, Actions **read and write**, Metadata **read**

In Credential Manager, paste the token. Click **Load my repositories**, select the repositories to sync, then **Save and test GitHub**.

Sync follows only the repositories listed there. It does not import every repository on the account.

GitHub manual runs work when the workflow file is on the repository's **default branch**. Use that branch in the pipeline form.

## 5. Azure DevOps (when you are ready)

Create a personal access token in Azure DevOps:

- Code: **Read & write**
- Build: **Read & execute**

In Credential Manager enter:

- Organization: the name in `https://dev.azure.com/your-org`
- Project name
- Personal access token
- Azure Repos repository name (needed when Concierto creates a pipeline)
- Branch, usually `main`

Click **Load repositories** if you need the exact repository name, then **Save and test Azure DevOps**.

Creating a pipeline from Concierto pushes a YAML file into that Azure Repos Git repository and registers an Azure Pipeline. Sync lists the pipelines already in the project.

## 6. Use the CI/CD menu

The left nav matches the Concierto shell. **CI/CD** is the working module. The other nav names are placeholders.

| Screen | What it does |
| --- | --- |
| Overview | Counts, connection status, recent runs, incidents, setup checklist |
| Applications | Register an app and its repository |
| Pipelines | Sync, create, link, edit, run, and remove pipelines |
| Environments | DEV, QA, and PROD are created the first time the server starts |
| Releases | Track a version and approve it |
| Artifacts | Filled when a run succeeds; you can add one by hand |
| Integrations | Test and sync each engine |
| Credential Manager | Read and write `creds.json` |
| Audit | Local history of changes and runs |

### Sync into Concierto

On Pipelines or Integrations, click **Sync from tools** or **Sync**. Jenkins jobs, GitHub workflows, and Azure Pipelines appear in one table. The HTML pipeline you already created in Jenkins shows up here after the Jenkins test succeeds.

### Create a pipeline in Concierto and publish it

1. Add an application if you want the pipeline tied to one.
2. **Create pipeline**.
3. Choose **Create the definition in Concierto and publish it to the engine**.
4. Pick Jenkins, GitHub Actions, or Azure DevOps.
5. Keep the **HTML page** template unless you only want echo stages. On Jenkins it writes `dist/index.html` with Windows `bat`. On GitHub and Azure it writes the same file on an Ubuntu runner.
6. Leave **Publish the definition to the engine** checked.
7. Click **Create**. The preview shows the Jenkinsfile or YAML before you save.

**Link a pipeline that already exists** does not overwrite the job. Use that for the HTML pipeline if you prefer not to import everything with Sync.

### Run, approval, and incidents

**Run** starts the real job: Jenkins build, GitHub `workflow_dispatch`, or an Azure Pipelines run. The page polls every few seconds and shows **Live** while a run is queued or running.

If **Require approval in Concierto** is checked, Run waits. **Approve and run** is what starts the engine. Push triggers are turned off for that pipeline so a direct push cannot skip the gate.

A failed run opens an incident on Overview. Close it there when you are done.

Editing a pipeline and checking **Replace the definition on the engine** overwrites that job or workflow file. Changing the engine creates the definition on the new engine and leaves the old one in place.

Deleting a pipeline removes it from Concierto. The extra checkbox also deletes the Jenkins job, the GitHub workflow file, or the Azure Pipeline. The Azure YAML file is left in the repo.

## Files

| Path | Purpose |
| --- | --- |
| `start-concierto-cicd.bat` | Starts the server |
| `server.js` | Local API and the web page |
| `engines.js` | Jenkins, GitHub, and Azure DevOps calls |
| `public/` | The Concierto page |
| `data/state.json` | Applications, pipelines, runs, audit. No tokens |
| Desktop `creds.json` | Jenkins token, GitHub token, Azure DevOps PAT |

`creds.json` is plain text on the desktop because this is a local prototype. Do not copy it into git or email.

## Troubleshooting

**Node.js was not found.** Install Node 18+ and open a new command window so `PATH` updates. The bat file also looks in `C:\Program Files\nodejs\`.

**Port 8088 is already in use.** The server switches to `8090` and prints that URL.

**Jenkins returned 401 or 403.** Use an API token, not the password. The user needs read, create, and build rights.

**No valid crumb.** Jenkins CSRF protection is on. The prototype requests a crumb automatically. If a reverse proxy strips cookies, call Jenkins at `http://127.0.0.1:8080` from WinTest_DND instead of a public URL.

**Cannot reach Jenkins.** The URL must be reachable from WinTest_DND. `127.0.0.1` works only when Jenkins is on that same machine.

**GitHub: Resource not accessible by personal access token.** Add the `workflow` scope, or Actions read and write on a fine-grained token.

**GitHub run stays queued and never appears.** The workflow file must be on the default branch, and GitHub can take a minute to list a new file. Run again after that.

**Azure DevOps 401 or 403.** Recreate the PAT with Code read and write and Build read and execute. Organization is only the short name, not the full URL.

**This page cannot reach the server.** Open `http://127.0.0.1:8088` on the machine where the bat window is running. Do not open `index.html` as a file.

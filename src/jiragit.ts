import JiraJS from "jira.js";
import openEditor from "open-editor";
import prompts from "prompts";
import type { ZodSchema } from "zod";
import { z } from "zod";
import { $, chalk, fs, os, path } from "zx";
import type { JiraConfig } from "./jiraConfig";

const configFilePath = path.join(os.homedir(), "./jiragit.config.json");

enum Action {
  CheckoutExistingIssue = "CheckoutExistingIssue",
  CreateNewIssue = "CreateNewIssue",
}

const DEFAULT_CONFIG: JiraConfig = {
  email: "me@mycompany.com",
  token:
    "TODO: generate in https://id.atlassian.com/manage-profile/security/api-tokens",
  host: "https://mycompany.atlassian.net",
  projectKey: "Example: for issue like ABC-123 ABC is the project key",
};

const JiraConfigSchema: ZodSchema<JiraConfig> = z.object({
  email: z.string().email(),
  token: z.string(),
  host: z.string().url(),
  projectKey: z.string(),
});

function logInfoData(text: string) {
  // eslint-disable-next-line no-console
  console.log(chalk.blue(text));
}

function getJiraIssueUrl({ host, key }: { host: string; key: string }) {
  return `${host}/browse/${key}`;
}

async function createBranchForExistingIssue({
  jiraClient,
  jiraConfig,
}: {
  jiraClient: JiraJS.Version2Client;
  jiraConfig: JiraConfig;
}) {
  const searchIssues = await jiraClient.issueSearch.searchForIssuesUsingJql({
    jql: "assignee in (currentUser()) and sprint in openSprints() and statusCategory in ('To Do') order by created DESC",
    fields: ["summary", "description"],
  });

  const { issue } = (await prompts([
    {
      type: "autocomplete",
      message: "Select an issue",
      name: "issue",
      // Because it requires a Promise in TypeScript
      // eslint-disable-next-line @typescript-eslint/require-await
      suggest: async (input: string, choices) => {
        return choices.filter((choice) => {
          return (
            choice.title.includes(input) || choice.description?.includes(input)
          );
        });
      },
      choices:
        searchIssues.issues?.map((issue) => {
          return {
            title: issue.key,
            value: issue,
            description: issue.fields.summary,
          };
        }) ?? [],
    },
  ])) as { issue: JiraJS.Version2.Version2Models.Issue };

  const { branchName } = (await prompts({
    type: "text",
    name: "branchName",
    message: "Creating a new branch",
    initial: `${issue.key}-${issue.fields.summary}`
      .replace(/ +/g, "-")
      .toLowerCase(),
  })) as { branchName: string | undefined };

  if (branchName == null) {
    return;
  }

  logInfoData(getJiraIssueUrl({ host: jiraConfig.host, key: issue.key }));

  await $`git checkout -b ${branchName}`;
}

async function initConfig() {
  fs.writeJsonSync(configFilePath, DEFAULT_CONFIG);
  logInfoData(`Created a config file in path "${configFilePath}"`);
  const { shouldOpenFile } = (await prompts({
    type: "confirm",
    name: "shouldOpenFile",
    message: "Do you want to open it now?",
    initial: true,
  })) as { shouldOpenFile: boolean };

  if (shouldOpenFile) {
    openEditor([
      {
        file: configFilePath,
      },
    ]);
    chalk.blue("Please edit your file an rerun the jiragit command");
  }
}

async function createBranchForNewJiraIssue({
  jiraClient,
  jiraConfig,
}: {
  jiraClient: JiraJS.Version2Client;
  jiraConfig: JiraConfig;
}) {
  const issueTypes = await jiraClient.issueTypes.getIssueAllTypes();
  const { issueType } = (await prompts([
    {
      type: "select",
      name: "issueType",
      message: "choose JIRA issue type",
      choices: issueTypes.flatMap((issueType) => {
        if (issueType.name == null) {
          return [];
        }
        return {
          value: issueType,
          title: issueType.name,
          description: issueType.description,
        };
      }),
    },
  ])) as { issueType: JiraJS.Version2Models.IssueTypeScheme };

  const { summary, description } = (await prompts([
    {
      type: "text",
      message: "enter JIRA issue summary",
      name: "summary",
    },
    {
      type: "text",
      message: "enter JIRA issue description",
      name: "description",
    },
  ])) as { summary: string; description: string };

  const currentUser = await jiraClient.myself.getCurrentUser();

  const newIssue = await jiraClient.issues.createIssue({
    fields: {
      issuetype: { id: issueType.id },
      project: {
        key: jiraConfig.projectKey,
      },
      assignee: {
        id: currentUser.accountId,
      },
      summary,
      description,
    },
  });

  logInfoData(getJiraIssueUrl({ host: jiraConfig.host, key: newIssue.key }));

  const initialBranchName = `${newIssue.key}-${summary}`
    .replace(/ +/g, "-")
    .toLowerCase();

  const { branchName } = (await prompts({
    type: "text",
    name: "branchName",
    message: "Creating a new branch",
    initial: initialBranchName,
  })) as { branchName: string | undefined };

  if (branchName == null) {
    return;
  }

  await $`git checkout -b ${branchName}`;
}

async function init() {
  const hasExistingConfig = fs.pathExistsSync(configFilePath);
  if (!hasExistingConfig) {
    await initConfig();
    return;
  }

  // unicorn/prefer-json-parse-buffer - TypeScript have problems converting string to buffer
  // security/detect-non-literal-fs-filename - configFilePath variable is constant
  // eslint-disable-next-line security/detect-non-literal-fs-filename, unicorn/prefer-json-parse-buffer
  const content: unknown = JSON.parse(fs.readFileSync(configFilePath, "utf8"));

  const jiraConfig: JiraConfig = JiraConfigSchema.parse(content);

  const { email, token, host } = jiraConfig;

  const jiraClient = new JiraJS.Version2Client({
    host,
    authentication: {
      basic: {
        email,
        apiToken: token,
      },
    },
  });

  const { action } = (await prompts({
    name: "action",
    message: "choose action",
    type: "select",
    choices: [
      {
        title: "Create new issue",
        value: Action.CreateNewIssue,
      },
      {
        title: "Choose existing issue",
        value: Action.CheckoutExistingIssue,
      },
    ],
  })) as { action: Action };

  switch (action) {
    case Action.CheckoutExistingIssue:
      return createBranchForExistingIssue({ jiraClient, jiraConfig });
    case Action.CreateNewIssue:
      return createBranchForNewJiraIssue({ jiraClient, jiraConfig });
  }
}

void init();

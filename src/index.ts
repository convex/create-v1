#!/usr/bin/env node

import { type ExecException, exec, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import boxen from "boxen";
import chalk from "chalk";
import { program } from "commander";
import dotenv from "dotenv";
import inquirer from "inquirer";
import ora, { type Ora } from "ora";

interface EnvVariable {
  name: string;
  projects: string[];
  details: string;
  required?: boolean;
  defaultValue?: string;
  template?: string;
  info?: string[];
}

interface SetupStep {
  title: string;
  instructions: string;
  variables: EnvVariable[];
  additionalInstructions?: string[];
  required?: boolean;
  description?: string;
  interactive?: boolean; // Add this new property
}

interface Project {
  id: string;
  envFile?: string;
  exportCommand?: string;
  importCommand?: string;
  ignoreLogs?: string[];
}

interface SetupConfig {
  introMessage: string;
  projects: Project[];
  steps: SetupStep[];
}

interface Values {
  convexUrl: string;
  convexSiteUrl: string;
}

function loadConfig(configPath: string): SetupConfig {
  console.log("Loading config from:", configPath);
  try {
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent) as SetupConfig;

    if (!Array.isArray(config.projects)) {
      throw new Error("Config file is missing the 'projects' array");
    }

    return config;
  } catch (error) {
    console.error(
      chalk.red(`Error loading config file: ${(error as Error).message}`)
    );
    process.exit(1);
  }
}

function updateEnvFile(filePath: string, key: string, value: string): void {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    // File doesn't exist, we'll create it
  }

  const envConfig = dotenv.parse(content);
  envConfig[key] = value;

  const newContent = Object.entries(envConfig)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  fs.writeFileSync(filePath, newContent);
}

function createLogger() {
  let enabled = true;
  return {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    log: (...args: any[]) => {
      if (enabled) {
        console.log(...args);
      }
    },
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    error: (...args: any[]) => {
      if (enabled) {
        console.error(...args);
      }
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

const logger = createLogger();

async function getExistingValue(
  projects: Project[],
  variable: EnvVariable,
  projectDir: string
): Promise<string | undefined> {
  for (const projectId of variable.projects) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) continue;

    if (project.envFile) {
      const envFilePath = path.join(projectDir, project.envFile);
      const value = getEnvFileValue(envFilePath, variable.name);
      if (value) return value;
    } else if (project.importCommand) {
      try {
        const convexDir = path.join(projectDir, "packages", "backend");
        const value = execSync(
          project.importCommand.replace("{{name}}", variable.name),
          {
            encoding: "utf-8",
            cwd: convexDir,
          }
        ).trim();

        if (value) return value;
      } catch (error) {
        console.error(chalk.red(`Error: ${(error as Error).message}`));
      }
    }
  }
  return undefined;
}

function getEnvFileValue(envFile: string, key: string): string | undefined {
  try {
    const envContent = fs.readFileSync(envFile, "utf-8");
    const envConfig = dotenv.parse(envContent);
    return envConfig[key];
  } catch (error) {
    // File doesn't exist or can't be read
    return undefined;
  }
}

async function updateProjectValue(
  project: Project,
  key: string,
  value: string,
  projectDir: string
): Promise<string | undefined> {
  if (project.envFile) {
    const envFilePath = path.join(projectDir, project.envFile);
    const relativePath = path.relative(process.cwd(), envFilePath);
    updateEnvFile(envFilePath, key, value);
    return relativePath;
  }
  if (project.exportCommand) {
    try {
      const convexDir = path.join(projectDir, "packages", "backend");
      execSync(
        project.exportCommand
          .replace("{{name}}", key)
          .replace("{{value}}", value),
        { stdio: "inherit", cwd: convexDir }
      );
    } catch (error) {
      console.error(`Failed to export value for ${key} to ${project.id}`);
      console.error(`Error: ${(error as Error).message}`);
    }
  }
  return undefined;
}

async function getConvexUrls(projectDir: string): Promise<{
  convexUrl: string;
  convexSiteUrl: string;
}> {
  const convexDir = path.join(projectDir, "packages", "backend");

  if (!fs.existsSync(convexDir)) {
    console.error(
      chalk.red(
        `Error: 'packages/backend' directory not found in ${projectDir}`
      )
    );
    process.exit(1);
  }

  try {
    const stdout = execSync("npx convex function-spec", {
      encoding: "utf-8",
      cwd: convexDir,
    }).trim();

    // Use a regular expression to extract the URL
    const urlMatch = stdout.match(/"url"\s*:\s*"(https:\/\/[^"]+)"/);
    if (!urlMatch) {
      throw new Error("Convex URL not found in function-spec output");
    }

    // biome-ignore lint/style/noNonNullAssertion: <explanation>
    const convexUrl = urlMatch[1]!;
    const convexSiteUrl = convexUrl.replace("convex.cloud", "convex.site");
    console.log(chalk.green("Successfully retrieved Convex URLs:"));
    console.log(chalk.green(`  convexUrl: ${convexUrl}`));
    console.log(chalk.green(`  convexSiteUrl: ${convexSiteUrl}`));
    return { convexUrl, convexSiteUrl };
  } catch (error) {
    console.error(
      chalk.red(`Failed to retrieve Convex URLs: ${(error as Error).message}`)
    );
    process.exit(1);
  }
}

// Add this utility function
function shouldIgnoreLog(message: string, ignoreLogs: string[] = []): boolean {
  return ignoreLogs.some((prefix) => message.startsWith(prefix));
}

async function setupEnvironment(
  projectDir: string,
  values: Values,
  configPath: string
): Promise<void> {
  const config = loadConfig(configPath);

  // Create a custom console logger
  const customConsole = {
    log: (message: string) => {
      if (
        !config.projects.some((p) => shouldIgnoreLog(message, p.ignoreLogs))
      ) {
        console.log(message);
      }
    },
    error: (message: string) => {
      if (
        !config.projects.some((p) => shouldIgnoreLog(message, p.ignoreLogs))
      ) {
        console.error(message);
      }
    },
  };

  customConsole.log(chalk.bold.cyan("\n🚀 Welcome to v1 Environment Setup"));
  customConsole.log(chalk.dim(config.introMessage));
  customConsole.log(chalk.dim("Press Ctrl+C at any time to exit\n"));

  for (const [index, step] of config.steps.entries()) {
    customConsole.log(chalk.bold.blue(`\n📍 Step ${index + 1}: ${step.title}`));

    if (step.description) {
      customConsole.log(chalk.dim(`\n${step.description}`));
    }

    customConsole.log(chalk.white(`\n${step.instructions}`));

    if (step.additionalInstructions) {
      customConsole.log(chalk.yellow("\nℹ️  Additional Instructions:"));
      for (const instruction of step.additionalInstructions) {
        customConsole.log(chalk.yellow(`  • ${instruction}`));
      }
      customConsole.log("");
    }

    // Check if the step is optional
    const isOptional = step.required === false;
    if (isOptional && step.interactive !== false) {
      const { setupStep } = await inquirer.prompt<{ setupStep: boolean }>([
        {
          type: "confirm",
          name: "setupStep",
          message: "This step is optional. Would you like to set it up?",
          default: true,
        },
      ]);

      if (!setupStep) {
        customConsole.log(chalk.yellow(`⏭️  Skipping ${step.title}`));
        continue;
      }
    }

    for (const variable of step.variables) {
      customConsole.log(chalk.cyan(`\n${variable.details}\n`));

      if (variable.info) {
        for (const infoItem of variable.info) {
          const processedInfo = infoItem.replace(
            /\{\{(\w+)\}\}/g,
            (_, key) => values[key as keyof Values] || `[${key} not set]`
          );
          customConsole.log(
            boxen(chalk.blue(processedInfo), {
              padding: 0.5,
              margin: 0.5,
              borderColor: "blue",
              borderStyle: "round",
              title: "ℹ️  Info",
              titleAlignment: "center",
            })
          );
        }
      }

      const existingValue = await getExistingValue(
        config.projects,
        variable,
        projectDir
      );
      const defaultValue =
        existingValue ||
        (variable.template
          ? variable.template.replace(
              /\{\{(\w+)\}\}/g,
              (_, key) => values[key as keyof Values] || ""
            )
          : variable.defaultValue);

      let value: string;

      if (step.interactive === false) {
        value = defaultValue || "";
      } else {
        const requiredText = variable.required === false ? " (optional)" : "";
        const answer = await inquirer.prompt([
          {
            type: "input",
            name: "value",
            message: `Enter ${chalk.bold(variable.name)}${requiredText}:`,
            default: defaultValue,
          },
        ]);
        value = answer.value;
      }

      if (value || variable.required !== false) {
        const updatedFiles: string[] = [];
        for (const projectId of variable.projects) {
          const project = config.projects.find((p) => p.id === projectId);
          if (project) {
            const updatedFile = await updateProjectValue(
              project,
              variable.name,
              value,
              projectDir
            );
            if (updatedFile) {
              updatedFiles.push(updatedFile);
            }
          }
        }
        if (updatedFiles.length > 0) {
          customConsole.log(chalk.green(`✅ Set ${variable.name} in:`));
          for (const file of updatedFiles) {
            customConsole.log(chalk.green(`   - ${file}`));
          }
        } else {
          customConsole.log(chalk.green(`✅ Set ${variable.name}`));
        }
      } else {
        customConsole.log(chalk.yellow(`⚠️ Skipped ${variable.name}`));
      }
    }

    customConsole.log(chalk.green("✅ Step completed"));
  }

  customConsole.log(
    chalk.bold.green(
      "\n🎉 Setup complete! Environment variables have been updated."
    )
  );
}

async function promptToContinue(message: string): Promise<void> {
  await inquirer.prompt([
    {
      type: "input",
      name: "continue",
      message: `${message}\nPress Enter to continue...`,
    },
  ]);
}

async function createNewProject(
  configPath: string,
  projectPath: string,
  branch = "main"
): Promise<void> {
  const projectDir = projectPath;
  const convexDir = path.join(projectDir, "packages", "backend");
  logger.log(
    chalk.bold.cyan(`\n🚀 Creating a new v1 project in ${projectDir}...\n`)
  );

  const tasks = [
    {
      title: "Cloning repository",
      task: async () => {
        // Check if setup-config.json exists in the project directory
        const projectDirExists = fs.existsSync(
          path.join(projectDir, "setup-config.json")
        );
        if (projectDirExists) {
          console.log(
            chalk.yellow("\nProject already cloned. Skipping this step.")
          );
          return true;
        }
        // If setup-config.json doesn't exist, proceed with cloning
        await new Promise<void>((resolve, reject) => {
          exec(
            `bunx tiged --disable-cache convex/v1#${branch} ${projectDir}`,
            (error: ExecException | null) => {
              if (error) reject(error);
              else resolve();
            }
          );
        });
        const setupConfigExists = fs.existsSync(
          path.join(projectDir, "setup-config.json")
        );
        if (setupConfigExists) {
          return;
        }
        console.error(
          chalk.red(`${projectDir}/setup-config.json does not exist.`)
        );
        process.exit(1);
      },
    },
    {
      title: "Installing dependencies",
      task: () =>
        new Promise<void>((resolve, reject) => {
          exec(
            "bun install",
            { cwd: projectDir },
            (error: ExecException | null) => {
              if (error) reject(error);
              else resolve();
            }
          );
        }),
    },
    {
      title: "Initializing git repository",
      task: async () =>
        new Promise((resolve, reject) => {
          const isGitRepo = fs.existsSync(path.join(projectDir, ".git"));
          if (!isGitRepo) {
            exec(
              'git init && git add . && git commit -m "Initial commit"',
              { cwd: projectDir },
              (error: ExecException | null) => {
                if (error) reject(error);
                else resolve(false);
              }
            );
          } else {
            console.log(chalk.yellow("\nGit repository already initialized."));
            resolve(true);
          }
        }),
    },
    {
      title: "Setting up Convex backend",
      task: async (spinner: Ora) => {
        spinner.stop();
        const isInitialized = fs.existsSync(path.join(convexDir, ".env.local"));
        if (isInitialized) {
          console.log(
            chalk.yellow("Convex already initialized. Skipping this step.")
          );
          return true;
        }
        await promptToContinue(
          "You'll now be guided through the Convex project setup process. This will create a new Convex project or link to an existing one."
        );

        await new Promise<void>((resolve, reject) => {
          const child = spawn("npm", ["run", "setup"], {
            stdio: "inherit",
            shell: true,
            cwd: convexDir,
          });

          child.on("exit", (code) => {
            if (code === 0 || code === null) {
              resolve();
            } else {
              reject();
            }
          });

          child.on("error", (error) => {
            reject(error);
          });
        });
      },
    },
    {
      title: "Setting up authentication",
      task: async (spinner: Ora) => {
        spinner.stop();
        await promptToContinue(
          "You'll now be guided through the authentication setup process. This will configure authentication for your Convex project."
        );

        return new Promise<void>((resolve, reject) => {
          const child = spawn("npx", ["@convex-dev/auth", "--skip-git-check"], {
            stdio: "inherit",
            shell: true,
            cwd: convexDir,
          });

          child.on("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(`Authentication setup failed with code ${code}`)
              );
            }
          });

          child.on("error", (error) => {
            reject(error);
          });
        });
      },
    },
    {
      title: "Setting up environment variables",
      task: async (spinner: Ora) => {
        spinner.stop();
        const { convexUrl, convexSiteUrl } = await getConvexUrls(projectDir);

        await setupEnvironment(
          projectDir,
          { convexUrl, convexSiteUrl },
          configPath
        );
      },
    },
    {
      title: "Seeding the database",
      task: async () => {
        return new Promise<void>((resolve, reject) => {
          const child = spawn("bun", ["run", "seed"], {
            stdio: "inherit",
            cwd: convexDir,
          });

          child.on("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Database seeding failed with code ${code}`));
            }
          });

          child.on("error", (error) => {
            reject(error);
          });
        });
      },
    },
  ];

  for (const task of tasks) {
    const spinner = ora(task.title).start();
    try {
      logger.setEnabled(false);
      const skipped = await task.task(spinner);
      if (skipped) {
        spinner.stop();
      } else {
        spinner.succeed();
      }
      logger.setEnabled(true);
    } catch (error) {
      logger.setEnabled(true);
      spinner.fail();
      logger.error(chalk.red(`Error during ${task.title.toLowerCase()}:`));
      logger.error(error || "See previous logs for details");
      process.exit(1);
    }
  }

  console.log(chalk.bold.green("\n🎉 Project setup complete!"));
  console.log(chalk.cyan("\nTo start your development server:"));
  if (projectDir !== ".") {
    console.log(
      chalk.white(`  cd ${path.relative(process.cwd(), projectDir)}`)
    );
  }
  console.log(chalk.white("  bun dev"));
  console.log(
    chalk.cyan("\nOnce the server is running, open your browser to:")
  );
  console.log(chalk.white("  http://localhost:3001"));
}

function checkBunInstallation(): boolean {
  try {
    execSync("bun --version", { stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

async function main() {
  console.log(chalk.bold.cyan("\n🌟 Welcome to Create v1"));

  // Check for Bun installation
  if (!checkBunInstallation()) {
    console.error(
      chalk.red("\n❌ Error: Bun is not installed or not in your PATH.")
    );
    console.log(chalk.yellow("Please install Bun before proceeding:"));
    console.log(chalk.cyan("https://bun.sh/docs/installation"));
    process.exit(1);
  }

  program
    .name("create-v1")
    .description("Create a new v1 project or manage environment variables")
    .argument("[project-name]", "Directory for the project")
    .option("--config <path>", "Path to custom setup-config.json")
    .option("--branch <branch>", "Branch to pull from in starter repo")
    .action(
      async (
        projectDirectory: string | undefined,
        options: { config?: string | boolean; branch?: string }
      ) => {
        const customProjectDir = projectDirectory
          ? path.resolve(process.cwd(), projectDirectory)
          : undefined;

        const customConfigPath = options.config
          ? path.resolve(
              process.cwd(),
              options.config === true ? "setup-config.json" : options.config
            )
          : undefined;
        if (customConfigPath) {
          console.log(chalk.yellow("\n⚠️ Using custom configuration"));
          console.log(chalk.yellow(`Config path: ${customConfigPath}`));
        }

        const { action } = await inquirer.prompt<{ action: string }>([
          {
            type: "list",
            name: "action",
            message: "What would you like to do?",
            choices: [
              { name: "Create a new v1 project", value: "create" },
              {
                name: "Manage environment variables for an existing project",
                value: "env",
              },
            ],
          },
        ]);

        if (action === "create") {
          const projectPath =
            customProjectDir ||
            path.resolve(
              process.cwd(),
              (
                await inquirer.prompt<{
                  inputProjectName: string;
                }>([
                  {
                    type: "input",
                    name: "inputProjectName",
                    message: "What is your project named?",
                    default: "my-v1-project",
                  },
                ])
              ).inputProjectName || "."
            );
          const configPath =
            customConfigPath || path.join(projectPath, "setup-config.json");

          await createNewProject(configPath, projectPath, options.branch);
        } else {
          const projectDir = customProjectDir || process.cwd();
          const { convexUrl, convexSiteUrl } = await getConvexUrls(projectDir);
          const configPath =
            customConfigPath || path.join(projectDir, "setup-config.json");
          await setupEnvironment(
            projectDir,
            { convexUrl, convexSiteUrl },
            configPath
          );
        }
      }
    );

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(chalk.red("\n❌ An error occurred during project setup:"));
  console.error(error);
  process.exit(1);
});

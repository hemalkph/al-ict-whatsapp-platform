import { parseArgs } from "node:util";
import { OperatorRefusedError, bootstrapFirstAdmin } from "@/modules/access/operator";
import { ValidationError } from "@/shared/errors/http-errors";
import { promptHidden } from "./prompt";

// OPERATOR-ONLY: creates the first organization and its first ADMIN. Not reachable from the web app.
//
//   npm run auth:bootstrap-admin -- --org-name "My Class" --org-slug my-class --email admin@example.com --name "Admin"
//
// The password is NEVER a command-line argument. It is read from a hidden interactive prompt, or (non-interactive
// automation/testing only) from the BOOTSTRAP_ADMIN_PASSWORD environment variable. It is never printed or stored.
// Refuses to run if any user already exists. The new admin must change the password at first sign-in.

const USAGE =
  'Usage: npm run auth:bootstrap-admin -- --org-name "<name>" --org-slug <slug> --email <email> --name "<display name>"';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "org-name": { type: "string" },
      "org-slug": { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values["org-name"] || !values["org-slug"] || !values.email || !values.name) {
    console.error(USAGE);
    return 2;
  }

  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) {
    password = await promptHidden("Admin password (12-128 characters): ");
    const again = await promptHidden("Repeat password: ");
    if (password !== again) {
      console.error("The passwords do not match.");
      return 2;
    }
  }

  try {
    const result = await bootstrapFirstAdmin({
      organizationName: values["org-name"],
      organizationSlug: values["org-slug"],
      email: values.email,
      name: values.name,
      password,
    });
    console.log(
      `Bootstrap ${result.resumed ? "resumed and " : ""}completed.\n` +
        `  organization: ${result.organizationId}\n  admin user:   ${result.userId}\n  membership:   ${result.membershipId}\n` +
        "The admin must change the password at first sign-in.",
    );
    return 0;
  } catch (error) {
    if (error instanceof OperatorRefusedError) console.error(`Refused: ${error.message}`);
    else if (error instanceof ValidationError)
      console.error(`Invalid input: ${error.fields.join(", ")}`);
    else
      console.error(
        "Bootstrap failed unexpectedly. Check the configuration (DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL).",
      );
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unexpected error.");
    process.exit(1);
  });

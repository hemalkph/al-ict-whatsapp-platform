import { parseArgs } from "node:util";
import {
  BootstrapRefusedError,
  bootstrapPlatformSecurityAdmin,
} from "@/modules/platform/bootstrap";
import { promptHidden } from "./prompt";

// OPERATOR-ONLY, ONE-TIME (Phase 08G-7B C1A): makes one EXISTING user the first platform security administrator.
//
//   npm run platform:bootstrap-operator -- --email <existing user> --verification-ref <owner reference>
//
// The owner verifies the person out of band first and passes only a short reference (letters, digits, . _ : -). The
// person themself then types the account's CURRENT password at the hidden prompt: it proves control of the account and is
// never an argument, environment variable, log line or file. Refused if any bootstrap ever happened on this database.

const USAGE =
  "Usage: npm run platform:bootstrap-operator -- --email <existing user email> --verification-ref <reference>";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { email: { type: "string" }, "verification-ref": { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.email || !values["verification-ref"]) {
    console.error(USAGE);
    return 2;
  }
  const password = await promptHidden("Password of that account (typed by its owner): ");
  try {
    const result = await bootstrapPlatformSecurityAdmin({
      email: values.email,
      password,
      verificationRef: values["verification-ref"],
    });
    console.log(
      `Platform bootstrap completed.\n  grant: ${result.grantId}\n  user:  ${result.userId}\n` +
        "This command can never succeed again on this database.",
    );
    return 0;
  } catch (error) {
    if (error instanceof BootstrapRefusedError) console.error(`Refused: ${error.reason}`);
    else console.error("Bootstrap failed unexpectedly. Check the configuration (DATABASE_URL).");
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unexpected error.");
    process.exit(1);
  });

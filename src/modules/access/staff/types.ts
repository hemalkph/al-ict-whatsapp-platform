import type { Database } from "@/db";
import type { ProvisioningAuth } from "@/modules/auth/provisioning";
import type { Role } from "../permissions";

/** A database transaction handle (what db.transaction passes to its callback). */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Dependency injection for tests; production uses the lazy defaults. */
export type StaffDeps = {
  readonly db?: Database;
  readonly provisioner?: ProvisioningAuth;
};

/** Safe staff view: no password hashes, credential rows, session tokens or provisioning state. */
export type StaffMember = {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly status: "ACTIVE" | "SUSPENDED";
  readonly passwordChangeRequired: boolean;
  readonly createdAt: Date;
};

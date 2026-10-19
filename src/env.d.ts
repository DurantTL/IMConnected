declare namespace App {
  interface Locals {
    /** Set by src/middleware.ts on /admin* and /api/admin/* only. */
    user?: import('./lib/auth/session').SessionUser;
    session?: import('./lib/auth/session').Session;
  }
}

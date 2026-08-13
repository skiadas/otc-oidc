export interface Account {
  accountId: string;
  email: string;
  firstSeen: number;
  lastLogin: number;
}

export class AccountStore {
  private users = new Map<string, Account>();

  touch(email: string): Account {
    const now = Date.now();
    let account = this.users.get(email);
    if (!account) {
      account = { accountId: email, email, firstSeen: now, lastLogin: now };
      this.users.set(email, account);
    }
    account.lastLogin = now;
    return account;
  }

  async findAccount(
    _ctx: unknown,
    sub: string,
  ): Promise<{
    accountId: string;
    claims: () => Promise<Record<string, unknown>>;
  }> {
    const account = this.users.get(sub);
    if (!account) throw new Error(`account not found: ${sub}`);

    return {
      accountId: account.accountId,
      claims: async () => ({
        sub: account.accountId,
        email: account.email,
        email_verified: true,
        preferred_username: account.email,
      }),
    };
  }
}

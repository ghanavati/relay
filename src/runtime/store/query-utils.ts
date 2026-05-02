/**
 * Composable SQL filter/pagination builder for better-sqlite3 queries.
 * Usage: construct a SqlFilterBuilder, call addEq/addGte/addFilter as needed,
 * then interpolate whereClause() and limitClause() into the SQL template and
 * spread bindParams() into .all() / .get() / .run().
 */
export class SqlFilterBuilder {
  private readonly conditions: string[] = [];
  private readonly params: unknown[] = [];

  addFilter(condition: string, ...values: unknown[]): this {
    this.conditions.push(condition);
    this.params.push(...values);
    return this;
  }

  addEq(field: string, value: unknown): this {
    if (value !== undefined) this.addFilter(`${field} = ?`, value);
    return this;
  }

  addGte(field: string, value: unknown): this {
    if (value !== undefined) this.addFilter(`${field} >= ?`, value);
    return this;
  }

  addLte(field: string, value: unknown): this {
    if (value !== undefined) this.addFilter(`${field} <= ?`, value);
    return this;
  }

  whereClause(): string {
    return this.conditions.length > 0 ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }

  bindParams(): unknown[] {
    return this.params;
  }

  static limitClause(limit?: number, defaultLimit = 500): string {
    return `LIMIT ${limit ?? defaultLimit}`;
  }
}

export interface ImpactInput {
  readonly targets: readonly string[];
  readonly changedPaths: readonly string[];
  readonly edges: readonly {readonly consumer: string; readonly provider: string}[];
  readonly uncertainConsumers: readonly string[];
}

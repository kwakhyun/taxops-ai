# AWS deployment module

This composition module provisions the stateful and runtime resources owned by TaxOps AI: KMS, a private versioned S3 bucket, Multi-AZ RDS PostgreSQL, ECS Fargate web, worker, and isolated reviewer services, task IAM, encrypted CloudWatch log groups, alarms, an operations dashboard, and web autoscaling.

It intentionally accepts an existing VPC, private subnets, ALB target group, private ClamAV endpoint, document-processing endpoint, DLP endpoint, semantic injection-classifier endpoint, and alarm topics. Network foundations, public DNS, WAF, certificate issuance, identity-provider configuration, immutable audit export, and organization-wide security controls normally belong to a shared platform stack.

Before applying:

1. Publish immutable web, worker, and reviewer images from the CI commit SHA.
2. Create separate Secrets Manager values for the RLS application, restricted worker, and reviewer database roles. Do not use the RDS owner account at runtime.
3. Run the Drizzle migration as a controlled one-off task, then seed only non-production environments.
4. Enable AWS Config, GuardDuty, Security Hub, VPC endpoints, backup policies, and log export according to the organization baseline.
5. Verify that the DLP, semantic classifier, document processor, and notification endpoints are private or egress-allowlisted and guarantee the configured processing region.
6. Replace the example variables and review the plan with the cloud and security owners.

The module is a deployment reference, not proof that this repository has been applied to an AWS account.

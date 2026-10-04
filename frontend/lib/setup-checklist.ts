import type { BusinessAgentDetail, OrganizationMember } from "./api";

export interface SetupCheck {
  label: string;
  detail: string;
  complete: boolean;
}

export function buildSetupChecklist(
  agent: BusinessAgentDetail | null,
  members: OrganizationMember[],
): SetupCheck[] {
  const bindings = agent?.resourceBindings ?? [];

  return [
    {
      label: "Factory verified",
      detail:
        agent?.arcTestnetFactory.verification === "fully_verified"
          ? `Arc ${agent.arcTestnetFactory.chainId}`
          : "Waiting for verified Arc factory manifest",
      complete: agent?.arcTestnetFactory.verification === "fully_verified",
    },
    bindingCheck(bindings, "operator_wallet", "Operator wallet active"),
    bindingCheck(
      bindings,
      "business_policy_vault_contract",
      "Policy vault active",
    ),
    bindingCheck(bindings, "milestone_escrow_contract", "Escrow active"),
    {
      label: "Owner present",
      detail: members.some(
        (member) => member.role === "OWNER" && member.status === "ACTIVE",
      )
        ? "Active owner membership found"
        : "Invite or restore an owner before activation",
      complete: members.some(
        (member) => member.role === "OWNER" && member.status === "ACTIVE",
      ),
    },
  ];
}

export function canExecute(checks: SetupCheck[]) {
  return checks.every((check) => check.complete);
}

function bindingCheck(
  bindings: BusinessAgentDetail["resourceBindings"],
  resourceType: string,
  label: string,
): SetupCheck {
  const binding = bindings.find((item) => item.resourceType === resourceType);
  return {
    label,
    detail: binding?.address ?? binding?.status ?? "Missing",
    complete: binding?.status === "ACTIVE",
  };
}

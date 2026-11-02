/**
 * Model spec resolution for the gateway.
 *
 * The gateway and the Pi harness both use `PI_MODEL`, but they mean different
 * things: the harness exports a bare model id plus a separate `PI_PROVIDER`,
 * while the gateway needs a `provider/id` pair to resolve a model. When the
 * gateway inherits the harness environment (for example when it is started
 * from a Pi session), the bare id has to be composed with its provider.
 */

export type ModelSpecSource = {
  /** Gateway-owned override (TELEGRAM_PI_MODEL). Must be `provider/id`. */
  gatewayModel?: string | undefined;
  /** Pi harness variable (PI_MODEL): bare model id or `provider/id`. */
  piModel?: string | undefined;
  /** Pi harness variable (PI_PROVIDER): provider name. */
  piProvider?: string | undefined;
};

export type ModelSpecOrigin = "gateway" | "pi-full" | "pi-composed" | "pi-unresolvable" | "unset";

export type ModelSpecResolution = {
  /** Normalized `provider/id` spec, or undefined when the default model must be used. */
  spec: string | undefined;
  origin: ModelSpecOrigin;
  warning?: string;
};

export function resolveModelSpec(source: ModelSpecSource): ModelSpecResolution {
  const gateway = source.gatewayModel?.trim();
  if (gateway) {
    return { spec: gateway, origin: "gateway" };
  }

  const piModel = source.piModel?.trim();
  if (!piModel) {
    return { spec: undefined, origin: "unset" };
  }

  if (piModel.includes("/")) {
    return { spec: piModel, origin: "pi-full" };
  }

  const piProvider = source.piProvider?.trim();
  if (piProvider) {
    return { spec: `${piProvider}/${piModel}`, origin: "pi-composed" };
  }

  return {
    spec: undefined,
    origin: "pi-unresolvable",
    warning:
      `PI_MODEL="${piModel}" has no provider and PI_PROVIDER is not set; ignoring it and using the default Pi model. ` +
      'Set TELEGRAM_PI_MODEL="<provider>/<id>" to pin a model.',
  };
}

export type ModelSpec = {
  provider: string;
  id: string;
};

export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  if (trimmed.includes("/")) {
    const [provider, ...idParts] = trimmed.split("/");
    const id = idParts.join("/");
    if (provider.length > 0 && id.length > 0) {
      return { provider, id };
    }
  }
  throw new Error(`Configured Pi model must be in provider/id format: ${trimmed}`);
}

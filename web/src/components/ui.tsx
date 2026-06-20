import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

export type NoticeKind = "success" | "error";

export interface NoticeMessage {
  readonly kind: NoticeKind;
  readonly text: string;
}

interface PageHeaderProps {
  readonly title: string;
  readonly subtitle: string;
}

export function PageHeader({ title, subtitle }: PageHeaderProps): JSX.Element {
  return (
    <>
      <h2>{title}</h2>
      <p className="subtitle">{subtitle}</p>
    </>
  );
}

interface CardProps {
  readonly title?: string;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Card({ title, icon, children, className = "" }: CardProps): JSX.Element {
  return (
    <div className={["card", className].filter(Boolean).join(" ")}>
      {title !== undefined && (
        <h3>
          {icon}
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

export function Notice({ message }: { readonly message: NoticeMessage | null }): JSX.Element | null {
  if (message === null) {
    return null;
  }
  const Icon = message.kind === "success" ? CheckCircle2 : XCircle;
  return (
    <div className={`notice ${message.kind}`}>
      <Icon className="notice-icon" size={16} aria-hidden="true" />
      <span>{message.text}</span>
    </div>
  );
}

interface StatusFlagProps {
  readonly active: boolean;
  readonly activeLabel?: string;
  readonly inactiveLabel?: string;
}

export function StatusFlag({ active, activeLabel = "set", inactiveLabel = "not set" }: StatusFlagProps): JSX.Element {
  return (
    <span className={active ? "ok" : "warn"}>
      {active ? <CheckCircle2 size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

interface NumericFieldProps {
  readonly label: string;
  readonly value: number;
  onChange(value: number): void;
}

export function NumericField({ label, value, onChange }: NumericFieldProps): JSX.Element {
  return (
    <>
      <label>{label}</label>
      <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </>
  );
}

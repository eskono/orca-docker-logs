export type Ticket = { signal: AbortSignal; controller: AbortController }

/** Each request lane accepts only its newest response, even across A → B → A navigation. */
export class RequestGate {
  private active: Ticket | null = null
  begin(replace = false): Ticket | null {
    if (this.active && !replace) return null
    this.invalidate()
    const controller = new AbortController()
    this.active = { signal: controller.signal, controller }
    return this.active
  }
  current(ticket: Ticket): boolean { return this.active === ticket && !ticket.signal.aborted }
  finish(ticket: Ticket): void { if (this.active === ticket) this.active = null }
  invalidate(): void { this.active?.controller.abort(); this.active = null }
}

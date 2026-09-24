import type { DPSState, LinkedSwitchGroup, LinkedSwitchMember, Logger } from './types'

type LinkedDevice = {
  context: { id: string; name?: string }
  connected: boolean
  update: (dps: DPSState) => boolean | undefined
  on: (event: 'change', listener: (changes: DPSState, state: DPSState) => void) => void
}

type BoundMember = LinkedSwitchMember & { dp: string }

export default class LinkedSwitchManager {
  private readonly log: Logger
  private readonly boundMembers = new Set<string>()
  private readonly initializedMembers = new Set<string>()
  private readonly pendingUpdates = new Set<string>()

  constructor(log: Logger) {
    this.log = log
  }

  bind(groups: LinkedSwitchGroup[] | undefined, devices: Map<string, LinkedDevice>): void {
    if (!Array.isArray(groups)) return

    groups.forEach((group, groupIndex) => {
      if (!Array.isArray(group.members) || group.members.length < 2) return

      const members = group.members
        .filter((member) => member && member.deviceId && member.dp !== undefined && member.dp !== null)
        .map((member) => ({ ...member, dp: String(member.dp) }))

      members.forEach((member) => {
        const device = devices.get(member.deviceId)
        const bindingKey = this._bindingKey(groupIndex, member)
        if (!device || this.boundMembers.has(bindingKey)) return

        this.boundMembers.add(bindingKey)
        device.on('change', (changes, state) => {
          this._handleChange(groupIndex, group, members, member, changes, state, devices)
        })
      })
    })
  }

  private _handleChange(
    groupIndex: number,
    group: LinkedSwitchGroup,
    members: BoundMember[],
    source: BoundMember,
    changes: DPSState,
    state: DPSState,
    devices: Map<string, LinkedDevice>,
  ): void {
    if (!Object.prototype.hasOwnProperty.call(changes, source.dp)) return

    const sourceKey = this._bindingKey(groupIndex, source)
    if (!this.initializedMembers.has(sourceKey)) {
      this.initializedMembers.add(sourceKey)
      return
    }

    const value = state[source.dp] ?? changes[source.dp]
    const pendingKey = this._pendingKey(groupIndex, source, value)
    if (this.pendingUpdates.delete(pendingKey)) return

    const groupName = group.name || `linked switch group ${groupIndex + 1}`
    const sourceDevice = devices.get(source.deviceId)
    members
      .filter((member) => member.deviceId !== source.deviceId || member.dp !== source.dp)
      .forEach((target) => {
        const targetDevice = devices.get(target.deviceId)
        if (!targetDevice) return
        if (!targetDevice.connected) {
          this.log.debug(
            `Linked switch group "${groupName}" skipped ${targetDevice.context.name || target.deviceId} because it is disconnected`,
          )
          return
        }

        const result = targetDevice.update({ [target.dp]: value })
        this.log.info(
          `Linked switch group "${groupName}" propagated ${sourceDevice?.context.name || source.deviceId} DP ${source.dp}=${JSON.stringify(value)} to ${targetDevice.context.name || target.deviceId} DP ${target.dp}, result=${result}`,
        )
        if (result === true) {
          const targetPendingKey = this._pendingKey(groupIndex, target, value)
          this.pendingUpdates.add(targetPendingKey)
          setTimeout(() => this.pendingUpdates.delete(targetPendingKey), 2000)
        }
      })
  }

  private _bindingKey(groupIndex: number, member: BoundMember): string {
    return `${groupIndex}:${member.deviceId}:${member.dp}`
  }

  private _pendingKey(groupIndex: number, member: BoundMember, value: unknown): string {
    return `${this._bindingKey(groupIndex, member)}:${JSON.stringify(value)}`
  }
}

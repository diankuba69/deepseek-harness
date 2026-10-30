/** Menginjeksi kegagalan tulis dan close hanya untuk payload snapshot ini. */
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'snapshot-fs-write-double-fault'

/**
 * Memasang kegagalan native tanpa mengubah penulisan log Session.
 * @param ctx - Konteks profil dengan kepemilikan disposer untuk injeksi.
 * @returns Setelah injeksi aktif dan handle probe ditutup.
 */
export async function apply(ctx: Context): Promise<void> {
  const handle = await open(join(process.cwd(), 'data.txt'), 'r')
  const prototype = Object.getPrototypeOf(handle) as Pick<FileHandle, 'writeFile'>
  await handle.close()
  const writeFile = prototype.writeFile
  ctx.effect(() => {
    prototype.writeFile = async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
      if (args[0] !== 'SNAPSHOT_DOUBLE_FAULT') return writeFile.call(this, ...args)
      const close = this.close.bind(this)
      this.close = async () => {
        await close()
        throw new Error('snapshot temp close failed')
      }
      throw Object.assign(new Error('snapshot write failed'), { code: 'EIO' })
    }
    return () => { prototype.writeFile = writeFile }
  })
}

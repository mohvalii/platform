//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import type { Doc, Tx, TxCreateDoc, Ref, Class, ServerStorage, DocumentQuery, FindOptions, FindResult, Storage, Account } from '@anticrm/core'
import core, { Hierarchy, TxFactory, ModelDb, DOMAIN_MODEL } from '@anticrm/core'
import type { Resource, Plugin } from '@anticrm/platform'
import { getResource, plugin } from '@anticrm/platform'

/**
 * @public
 */
export type TriggerFunc = (tx: Tx, txFactory: TxFactory) => Promise<Tx[]>

/**
  * @public
  */
export interface Trigger extends Doc {
  trigger: Resource<TriggerFunc>
}

/**
 * @public
 */
export class Triggers {
  private readonly triggers: TriggerFunc[] = []

  async tx (tx: Tx): Promise<void> {
    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<Doc>
      if (createTx.objectClass === serverCore.class.Trigger) {
        const trigger = (createTx as TxCreateDoc<Trigger>).attributes.trigger
        const func = await getResource(trigger)
        this.triggers.push(func)
      }
    }
  }

  async apply (account: Ref<Account>, tx: Tx): Promise<Tx[]> {
    const derived = this.triggers.map(trigger => trigger(tx, new TxFactory(account)))
    const result = await Promise.all(derived)
    return result.flatMap(x => x)
  }
}

/**
 * @public
 */
export interface DbAdapter extends Storage {
  init: () => Promise<void>
}

/**
 * @public
 */
export type DbAdapterFactory = (hierarchy: Hierarchy, url: string, db: string) => Promise<[DbAdapter, Tx[]]>

class TServerStorage implements ServerStorage {
  constructor (
    private readonly dbAdapter: Storage,
    private readonly hierarchy: Hierarchy,
    private readonly triggers: Triggers,
    private readonly modeldb: ModelDb
  ) {
  }

  async findAll<T extends Doc> (
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    const domain = this.hierarchy.getDomain(clazz)
    console.log('findAll', clazz, domain, query)
    if (domain === DOMAIN_MODEL) return await this.modeldb.findAll(clazz, query, options)
    return await this.dbAdapter.findAll(clazz, query, options)
  }

  async tx (tx: Tx): Promise<Tx[]> {
    if (tx.objectSpace === core.space.Model) {
      this.hierarchy.tx(tx)
      await this.modeldb.tx(tx)
      await this.triggers.tx(tx)
      return [] // we do not apply triggers on model changes?
    } else {
      await this.dbAdapter.tx(tx)
      const derived = await this.triggers.apply(tx.modifiedBy, tx)
      for (const tx of derived) {
        await this.dbAdapter.tx(tx) // triggers does not generate changes to model objects?
      }
      return derived
    }
  }
}

/**
 * @public
 */
export async function createServerStorage (factory: DbAdapterFactory, url: string, db: string): Promise<ServerStorage> {
  const hierarchy = new Hierarchy()
  const model = new ModelDb(hierarchy)
  const triggers = new Triggers()

  const [dbAdapter, txes] = await factory(hierarchy, url, db)

  for (const tx of txes) {
    hierarchy.tx(tx)
  }

  for (const tx of txes) {
    await model.tx(tx)
    await triggers.tx(tx)
  }

  await dbAdapter.init()

  return new TServerStorage(dbAdapter, hierarchy, triggers, model)
}

/**
 * @public
 */
export const serverCoreId = 'server-core' as Plugin

/**
 * @public
 */
const serverCore = plugin(serverCoreId, {
  class: {
    Trigger: '' as Ref<Class<Trigger>>
  }
})

export default serverCore

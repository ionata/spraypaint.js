import { SpraypaintBase, ModelRecord } from "../model"
import { IncludeDirective, IncludeScopeHash } from "./include-directive"
import { IncludeScope } from "../scope"
import { tempId } from "./temp-id"
import {
  JsonapiRequestDoc,
  JsonapiResourceIdentifier,
  JsonapiResourceMethod,
  JsonapiResource
} from "../jsonapi-spec"
import { Attribute } from "../attribute"

export class WritePayload<T extends SpraypaintBase> {
  model: T
  jsonapiType: string
  includeDirective: IncludeScopeHash
  included: JsonapiResource[] = []
  idOnly: boolean = false

  constructor(model: T, relationships?: IncludeScope, idOnly: boolean = false) {
    const includeDirective = new IncludeDirective(relationships)
    this.includeDirective = includeDirective.toScopeObject()
    this.model = model
    this.idOnly = idOnly

    if (!model.klass.jsonapiType) {
      throw new Error("Cannot serialize model: Undefined jsonapiType")
    }
    this.jsonapiType = model.klass.jsonapiType
  }

  attributes() {
    const attrs: ModelRecord<T> = {}

    this._eachAttribute((key, value, attrDef) => {
      if (!this.model.isPersisted || (<any>this.model.changes())[key]) {
        let writeKey = this.model.klass.serializeKey(key)

        if (attrDef.type === Number && (value as any) === "") {
          attrs[writeKey] = null
        } else {
          attrs[writeKey] = value
        }
      }
    })

    return attrs
  }

  removeDeletions(model: T, includeDirective: IncludeScope) {
    Object.keys(includeDirective).forEach(key => {
      const nested = (<any>includeDirective)[key]

      const modelIdx = <any>model
      const relatedObjects = modelIdx[key]
      if (relatedObjects) {
        if (Array.isArray(relatedObjects)) {
          relatedObjects.forEach((relatedObject, index) => {
            if (
              relatedObject.isMarkedForDestruction ||
              relatedObject.isMarkedForDisassociation
            ) {
              modelIdx[key].splice(index, 1)
            } else {
              this.removeDeletions(relatedObject, nested)
            }
          })
        } else {
          const relatedObject = relatedObjects
          if (
            relatedObject.isMarkedForDestruction ||
            relatedObject.isMarkedForDisassociation
          ) {
            modelIdx[key] = null
          } else {
            this.removeDeletions(relatedObject, nested)
          }
        }
      }
    })
  }

  postProcess() {
    this.removeDeletions(this.model, this.includeDirective)
    this.model.resetRelationTracking(this.includeDirective)
  }

  relationships(): object {
    const _relationships: any = {}

    Object.keys(this.includeDirective).forEach((key: any) => {
      const nested = (<any>this.includeDirective)[key]

      let idOnly = false
      if (key.indexOf(".") > -1) {
        key = key.split(".")[0]
        idOnly = true
      }

      let data: any
      const relatedModels = (<any>this.model)[key]

      if (relatedModels === null) {
        _relationships[this.model.klass.serializeKey(key)] = { data: null }
        return
      }

      if (relatedModels) {
        if (Array.isArray(relatedModels)) {
          data = []
          relatedModels.forEach(relatedModel => {
            if (
              !this._isNewAndMarkedForDestruction(relatedModel) &&
              (idOnly ||
                this.model.hasDirtyRelation(key, relatedModel) ||
                relatedModel.isDirty(nested))
            ) {
              data.push(this._processRelatedModel(relatedModel, nested, idOnly))
            }
          })
          if (data.length === 0) {
            data = null
          }
        } else {
          // Either the related model is dirty, or it's a dirty relation
          // (maybe the "department" is not dirty, but the employee changed departments
          // or the model is new
          if (
            !this._isNewAndMarkedForDestruction(relatedModels) &&
            (idOnly ||
              this.model.hasDirtyRelation(key, relatedModels) ||
              relatedModels.isDirty(nested))
          ) {
            data = this._processRelatedModel(relatedModels, nested, idOnly)
          }
        }

        if (data) {
          _relationships[this.model.klass.serializeKey(key)] = { data }
        }
      }
    })

    return _relationships
  }

  asJSON(): JsonapiRequestDoc {
    const data: JsonapiResource = {
      type: this.jsonapiType
    }

    if (this.model.id) {
      data.id = this.model.id
    }

    if (this.model.temp_id) {
      data["temp-id"] = this.model.temp_id
    }

    if (!this.idOnly) {
      const _attributes = this.attributes()
      if (Object.keys(_attributes).length > 0) {
        data.attributes = _attributes
      }
    }

    const relationshipData = this.relationships()
    if (Object.keys(relationshipData).length > 0) {
      data.relationships = relationshipData
    }

    const json: JsonapiRequestDoc = { data }

    if (this.included.length > 0) {
      json.included = this.included
    }

    const _meta: object = this.model.meta
    if (this.model.isMetaDirty && Object.keys(_meta).length > 0) {
      data.meta = _meta
    }

    return json
  }

  // private

  private _isNewAndMarkedForDestruction(model: any): boolean {
    return !model.isPersisted && model.isMarkedForDestruction
  }

  private _processRelatedModel(
    model: T,
    nested: IncludeScopeHash,
    idOnly: boolean
  ) {
    model.clearErrors()

    if (!model.isPersisted) {
      model.temp_id = tempId.generate()
    }

    const wp = new WritePayload(model, nested, idOnly)
    const relatedJSON = wp.asJSON().data

    if (!this._isNewAndMarkedForDestruction(model)) {
      this._pushInclude(relatedJSON)
    }

    wp.included.forEach(incl => {
      if (!this._isNewAndMarkedForDestruction(model)) {
        this._pushInclude(incl)
      }
    })

    const resourceIdentifier = this._resourceIdentifierFor(model)
    return resourceIdentifier
  }

  private _resourceIdentifierFor(model: T) {
    if (!model.klass.jsonapiType) {
      throw new Error(
        `Cannot serialize model: Undefined jsonapiType for model ${model}`
      )
    }

    const identifier: JsonapiResourceIdentifier = {
      type: model.klass.jsonapiType
    }

    if (model.id) {
      identifier.id = model.id
    }

    if (model.temp_id) {
      identifier["temp-id"] = model.temp_id
    }

    let method: JsonapiResourceMethod
    if (model.isPersisted) {
      if (model.isMarkedForDestruction) {
        method = "destroy"
      } else if (model.isMarkedForDisassociation) {
        method = "disassociate"
      } else {
        method = "update"
      }
    } else {
      method = "create"
    }
    identifier.method = method

    return identifier
  }

  private _pushInclude(include: any) {
    if (!this._isIncluded(include)) {
      this.included.push(include)
    }
  }

  private _isIncluded(include: any) {
    this.included.forEach(incl => {
      if (incl.type === include.type) {
        if (incl.id === include.id || incl["temp-id"] === include["temp-id"]) {
          return true
        }
      }
    })
    return false
  }

  private _eachAttribute<K extends Extract<keyof T, string>>(
    callback: (key: K, val: T[K], attrDef: Attribute) => void
  ): void {
    const modelAttrs = this.model.typedAttributes

    Object.keys(modelAttrs).forEach(key => {
      let attrDef = this.model.klass.attributeList[key]
      if (attrDef.persist) {
        const value = modelAttrs[key]
        callback(key as K, value, attrDef)
      }
    })
  }
}

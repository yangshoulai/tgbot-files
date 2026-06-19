export type DocAudience = "api-key" | "admin" | "public";
export type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type RequiredMark = "是" | "否" | "条件";

export interface ParameterDoc {
  name: string;
  location: "Header" | "Cookie" | "Path" | "Query" | "Body" | "FormData" | "Body/FormData" | "Query/Body/FormData" | "Response";
  required: RequiredMark;
  type: string;
  limit: string;
  description: string;
}

export interface EndpointDoc {
  id: string;
  method: Method;
  path: string;
  title: string;
  auth: string;
  summary: string;
  functionality: string;
  useCases: string[];
  limits: string[];
  specialHandling: string[];
  requestParams: ParameterDoc[];
  responseParams: ParameterDoc[];
  requestExample: string;
  responseExample: string;
}

export interface DocSection {
  id: string;
  title: string;
  description: string;
  endpoints: EndpointDoc[];
}

export interface DocGroup {
  title: string;
  description: string;
  sections: DocSection[];
}
